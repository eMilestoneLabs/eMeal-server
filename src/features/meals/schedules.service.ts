import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { SchedulesRepository } from './repositories/schedules.repository';
import { MealsRepository } from './repositories/meals.repository';
import { GroupsRepository } from '../groups/repositories/groups.repository';
import { ScheduleSerializer } from './serializers/schedule.serializer';
import { AuditService } from '../../audit/audit.service';
import { CreateScheduleDto, CreateScheduleEntryDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto, CloneScheduleDto } from './dto/update-schedule.dto';
import type { RealtimeEventsService } from '../../realtime/services/realtime-events.service';
import { QuerySchedulesDto } from './dto/query-meals.dto';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { RedisService } from '../../redis/redis.service';
import { invalidateTodayMealsCache } from './utils/today-meals-cache.util';

/**
 * Compute day of week (0=Monday...6=Sunday) from a Date object.
 * JS Date.getDay() returns 0=Sunday...6=Saturday — we need 0=Monday.
 */
function toDayOfWeek(date: Date): number {
  const jsDay = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  return jsDay === 0 ? 6 : jsDay - 1; // 0=Mon...6=Sun
}

/**
 * Parse YYYY-MM-DD string to UTC midnight Date.
 */
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Validate that a date is a Monday (dayOfWeek === 0 in our 0=Monday system).
 */
function isMonday(date: Date): boolean {
  return toDayOfWeek(date) === 0;
}

/** Human day labels (0=Monday…6=Sunday) for actionable validation errors. */
const DAY_LABELS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;

/**
 * SchedulesService — business logic for meal schedule CRUD, publishing, and cloning.
 *
 * Key rules:
 * - Admin creates/updates schedules; students can only read published ones.
 * - weekStartDate MUST be a Monday (validated in service, not DTO).
 * - Publishing is idempotent — safe to call multiple times.
 * - Clone creates a draft schedule for a new week.
 * - Entries validated: mealId must belong to the same group and org.
 * - Org isolation: organizationId always from JWT.
 */
@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    private readonly schedulesRepo: SchedulesRepository,
    private readonly mealsRepo: MealsRepository,
    private readonly groupsRepo: GroupsRepository,
    private readonly audit: AuditService,
    @Optional() @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
    // Perf (2026-07-19): GET /meals/today bundle cache — schedule mutations
    // change the planner overlay students see, so they must drop it.
    // @Optional keeps unit tests constructing the service unchanged.
    @Optional()
    @Inject(RedisService)
    private readonly redis: RedisService | null = null,
  ) {}

  /** Drop the group's cached today-bundles (fail-soft; org-wide if no group). */
  private async invalidateTodayCache(
    organizationId: string,
    groupId?: string,
  ): Promise<void> {
    await invalidateTodayMealsCache(this.redis, organizationId, groupId);
  }

  // ── CREATE ────────────────────────────────────────────────────────────────

  async createSchedule(
    adminId: string,
    organizationId: string,
    dto: CreateScheduleDto,
    requestId?: string,
  ) {
    // Verify group belongs to org
    const group = await this.groupsRepo.findById(dto.groupId, organizationId);
    if (!group) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    if (!group.weeklyMenuEnabled) {
      throw new BadRequestException({
        message: 'Weekly menu is disabled for this group',
        errors: { groupId: 'Enable weeklyMenuEnabled in group meal config first' },
      });
    }

    // Parse and validate weekStartDate must be a Monday
    const weekStart = parseLocalDate(dto.weekStartDate);
    if (!isMonday(weekStart)) {
      throw new BadRequestException({
        message: 'weekStartDate must be a Monday',
        errors: { weekStartDate: `${dto.weekStartDate} is not a Monday` },
      });
    }

    // Build entry data with server-side dayOfWeek computation
    const entries = await this.buildEntryData(
      dto.groupId,
      organizationId,
      dto.entries ?? [],
    );

    const schedule = await this.schedulesRepo.create({
      organizationId,
      groupId: dto.groupId,
      weekStart,
      entries,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: schedule.id,
      targetType: 'MealSchedule',
      action: 'create',
      metadata: { weekStartDate: dto.weekStartDate, entryCount: entries.length },
      requestId,
    });

    this.logger.log(`Schedule created: \${schedule.id} week=\${dto.weekStartDate}`);

    this.realtime?.emitScheduleUpdated(organizationId, {
      organizationId,
      groupId: schedule.groupId,
      scheduleId: schedule.id,
      weekStart: schedule.weekStart.toISOString(),
      isPublished: false,
    });

    return ScheduleSerializer.toResponse(schedule);
  }

  // ── LIST ──────────────────────────────────────────────────────────────────

  async getSchedules(
    userId: string,
    role: string,
    organizationId: string,
    query: QuerySchedulesDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const isAdmin = ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'].includes(role);

    if (!query.groupId) {
      throw new BadRequestException({
        message: 'groupId is required',
        errors: { groupId: 'Provide a groupId query parameter' },
      });
    }

    // Students see published schedules only
    const publishedOnly = !isAdmin || !!query.publishedOnly;

    // command_6 perf: the schedule query is org-scoped itself, so the group
    // 404 probe (select id — no member-array payload) runs CONCURRENTLY with
    // it; the gate is still checked before anything is returned.
    const [groupExists, result] = await Promise.all([
      this.groupsRepo.existsInOrg(query.groupId, organizationId),
      this.schedulesRepo.findByGroup(query.groupId, organizationId, {
        page,
        limit,
        publishedOnly,
      }),
    ]);
    if (!groupExists) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    return PaginatedResponseDto.of(
      ScheduleSerializer.toList(result.data),
      result.total,
      result.page,
      result.limit,
    );
  }

  // ── GET ONE ───────────────────────────────────────────────────────────────

  async getScheduleById(
    id: string,
    organizationId: string,
    role: string,
  ) {
    const isAdmin = ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'].includes(role);

    if (!isAdmin) {
      // Students read the PUBLISHED SNAPSHOT (preserved across draft edits),
      // never the live draft entries.
      const published = await this.schedulesRepo.findPublishedById(
        id,
        organizationId,
      );
      if (!published) {
        throw new NotFoundException({
          message: 'Schedule not found',
          errors: { id: 'Schedule is not yet published' },
        });
      }
      return ScheduleSerializer.toResponse(published);
    }

    const schedule = await this.schedulesRepo.findById(id, organizationId);
    if (!schedule) {
      throw new NotFoundException({
        message: 'Schedule not found',
        errors: { id: 'Schedule does not exist in your organization' },
      });
    }

    return ScheduleSerializer.toResponse(schedule);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────

  async updateSchedule(
    id: string,
    organizationId: string,
    adminId: string,
    dto: UpdateScheduleDto,
    requestId?: string,
  ) {
    const existing = await this.schedulesRepo.findById(id, organizationId);
    if (!existing) {
      throw new NotFoundException({
        message: 'Schedule not found',
        errors: { id: 'Schedule does not exist in your organization' },
      });
    }

    // Issue 1: editing a PUBLISHED week is allowed — it updates the live draft
    // entries only. The published snapshot students read stays frozen until the
    // admin re-publishes, so students never see the in-progress draft.

    let newWeekStart: Date | undefined;
    if (dto.weekStartDate !== undefined) {
      newWeekStart = parseLocalDate(dto.weekStartDate);
      if (!isMonday(newWeekStart)) {
        throw new BadRequestException({
          message: 'weekStartDate must be a Monday',
          errors: { weekStartDate: `${dto.weekStartDate} is not a Monday` },
        });
      }
    }

    let entries: any[] | undefined;
    if (dto.entries !== undefined) {
      entries = await this.buildEntryData(
        existing.groupId,
        organizationId,
        dto.entries,
      );
    }

    const updated = await this.schedulesRepo.update(id, organizationId, {
      weekStart: newWeekStart,
      entries,
      replaceEntries: dto.replaceEntries ?? false,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'MealSchedule',
      action: 'update',
      metadata: { entryCount: entries?.length },
      requestId,
    });

    // Perf (2026-07-19): edits can land on a published week (auto-draft flows
    // still snapshot-read, but per-day published edits exist) — drop the
    // group's today-bundle so students never see a stale overlay.
    await this.invalidateTodayCache(
      organizationId,
      (updated as any)?.groupId ?? (existing as any)?.groupId,
    );

    return ScheduleSerializer.toResponse(updated);
  }

  // ── PUBLISH ───────────────────────────────────────────────────────────────

  /**
   * Publish a schedule — makes it visible to students.
   * Idempotent: calling publish on an already-published schedule is safe.
   */
  async publishSchedule(
    id: string,
    organizationId: string,
    adminId: string,
    requestId?: string,
    dto?: UpdateScheduleDto,
  ) {
    // Issue 2: when the publish request carries entries (admin edited a
    // previously-published week), atomically REPLACE the entries AND publish in
    // one transaction so students keep seeing the last published version until
    // the swap commits — no draft / master-config gap. Without entries this is
    // the original idempotent flag-flip publish.
    let schedule;
    if (dto?.entries !== undefined) {
      const existing = await this.schedulesRepo.findById(id, organizationId);
      if (!existing) {
        throw new NotFoundException({
          message: 'Schedule not found',
          errors: { id: 'Schedule does not exist in your organization' },
        });
      }
      const entries = await this.buildEntryData(
        existing.groupId,
        organizationId,
        dto.entries,
      );
      schedule = await this.schedulesRepo.replaceAndPublish(
        id,
        organizationId,
        entries,
      );
    } else {
      // SRS Module 03 MMT-011 (publish-blocked bug): entries referencing a
      // meal deleted/disabled since the draft was saved previously failed the
      // whole publish with a 422 — permanently, because nothing ever cleaned
      // them up. A master meal deletion must be REMOVED from future days on
      // re-publish, never block it: stale entries are auto-dropped (audited),
      // then the remaining valid week publishes.
      const existing = await this.schedulesRepo.findById(id, organizationId);
      if (!existing) {
        throw new NotFoundException({
          message: 'Schedule not found',
          errors: { id: 'Schedule does not exist in your organization' },
        });
      }
      // Live-Test-5 ISSUE-5: the entity view now HIDES stale entries (the
      // planner auto-draft), so the self-heal detects them at the DB level —
      // same rule (meal deleted/disabled), same audited hard drop on publish.
      {
        const stale =
          (await this.schedulesRepo.findStaleEntries?.(id, organizationId)) ??
          [];
        if (stale.length > 0) {
          await this.schedulesRepo.deleteEntriesByIds(
            id,
            organizationId,
            stale.map((e) => e.id),
          );
          this.audit.log({
            organizationId,
            actorId: adminId,
            targetId: id,
            targetType: 'MealSchedule',
            action: 'update',
            metadata: {
              autoRemovedStaleEntries: stale.map((e) => ({
                mealId: e.mealId,
                mealName: e.mealName,
                dayOfWeek: e.dayOfWeek,
              })),
              reason: 'meal deleted or disabled after drafting (MMT-011)',
            },
            requestId,
          });
        }
      }
      schedule = await this.schedulesRepo.publish(id, organizationId);
    }

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'MealSchedule',
      action: 'update',
      metadata: { published: true, weekStartDate: schedule.weekStart.toISOString() },
      requestId,
    });

    this.logger.log(`Schedule published: \${id}`);

    this.realtime?.emitSchedulePublished(schedule.groupId, organizationId, {
      organizationId,
      groupId: schedule.groupId,
      scheduleId: schedule.id,
      weekStart: schedule.weekStart.toISOString(),
      isPublished: true,
    });

    // Perf (2026-07-19): publish replaces the snapshot the today overlay
    // reads — drop the group's cached today-bundle.
    await this.invalidateTodayCache(
      organizationId,
      (schedule as any)?.groupId,
    );

    return ScheduleSerializer.toResponse(schedule);
  }

  // ── REVERT (Issue 2) ──────────────────────────────────────────────────────

  /**
   * Revert a published schedule back to draft so the admin can edit it again
   * and re-publish (Issue 2). Additive — mirrors publishSchedule with the
   * inverse state. Idempotent: reverting an already-draft schedule is safe.
   */
  async revertToDraft(
    id: string,
    organizationId: string,
    adminId: string,
    requestId?: string,
    // Pass 15 (FR-SCHX-003): hide=true fully unpublishes — students stop
    // seeing the week; the snapshot stays recoverable in the row. Default
    // keeps the legacy snapshot-stays-visible revert.
    hide = false,
  ) {
    const schedule = await this.schedulesRepo.revert(id, organizationId, hide);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'MealSchedule',
      action: 'update',
      metadata: {
        published: false,
        hiddenFromStudents: hide,
        weekStartDate: schedule.weekStart.toISOString(),
      },
      requestId,
    });

    this.logger.log(`Schedule reverted to draft: ${id}`);

    this.realtime?.emitSchedulePublished(schedule.groupId, organizationId, {
      organizationId,
      groupId: schedule.groupId,
      scheduleId: schedule.id,
      weekStart: schedule.weekStart.toISOString(),
      isPublished: false,
    });

    // Perf (2026-07-19): hide=true unpublishes the week students see.
    await this.invalidateTodayCache(
      organizationId,
      (schedule as any)?.groupId,
    );

    return ScheduleSerializer.toResponse(schedule);
  }

  // ── CLONE ─────────────────────────────────────────────────────────────────

  /**
   * Clone a schedule to a new week.
   * Clone is always a DRAFT — admin must publish separately.
   */
  async cloneSchedule(
    sourceId: string,
    organizationId: string,
    adminId: string,
    dto: CloneScheduleDto,
    requestId?: string,
  ) {
    const targetWeekStart = parseLocalDate(dto.targetWeekStartDate);
    if (!isMonday(targetWeekStart)) {
      throw new BadRequestException({
        message: 'targetWeekStartDate must be a Monday',
        errors: { targetWeekStartDate: `${dto.targetWeekStartDate} is not a Monday` },
      });
    }

    const cloned = await this.schedulesRepo.clone(
      sourceId,
      organizationId,
      targetWeekStart,
      // Pass 15 (FR-SCHX-005): explicit replace only — never silent overwrite.
      dto.replace === true,
    );

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: cloned.id,
      targetType: 'MealSchedule',
      action: 'create',
      metadata: {
        clonedFrom: sourceId,
        targetWeekStartDate: dto.targetWeekStartDate,
        replacedExisting: dto.replace === true,
      },
      requestId,
    });

    this.logger.log(`Schedule cloned: ${sourceId} → ${cloned.id} week=${dto.targetWeekStartDate}`);

    return ScheduleSerializer.toResponse(cloned);
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────

  /**
   * Build and validate entry data from DTOs.
   * Verifies each mealId belongs to the group and org.
   * Computes dayOfWeek from date (server-side).
   */
  private async buildEntryData(
    groupId: string,
    organizationId: string,
    entriesDto: Array<{
      id?: string;
      mealId: string;
      date: string;
      mealName?: string | null;
      notes?: string | null;
      description?: string | null;
      imageUrl?: string | null;
      attendanceWindow?: { openTime: string; closeTime: string } | null;
      preferencesEnabled?: boolean | null;
      enabledPreferences?: string[] | null;
      enabledPreferenceGroupIds?: string[] | null;
      menuItems?: string[] | null;
      price?: number | null;
    }>,
  ) {
    const validatedEntries: Array<{
      id?: string;
      mealId: string;
      dayOfWeek: number;
      date: Date;
      mealName: string | null;
      notes: string | null;
      description: string | null;
      imageUrl: string | null;
      openTime: string | null;
      closeTime: string | null;
      preferencesEnabled: boolean | null;
      enabledPreferences: string[];
      enabledPreferenceGroupIds: string[];
      menuItems: string[];
      price: number | null;
    }> = [];

    // FR-MEAL-032 (ISSUE-4/ISSUE-11): validate ALL entries against the group's
    // meal catalogue in ONE query and reject genuine client errors with an
    // actionable, machine-readable 422 identifying the exact day + meal.
    //
    // SRS Module 03 MMT-011 (publish-blocked bug): a meal deleted or disabled
    // AFTER the week was drafted is NOT a client error — it is auto-dropped
    // here, so saving/publishing a week can never be permanently blocked by a
    // master-config change. Only a mealId the group has never known rejects.
    const { active, known } = await this.mealCatalogue(groupId, organizationId);

    for (const entry of entriesDto) {
      const date = parseLocalDate(entry.date);
      if (!active.has(entry.mealId)) {
        if (known.has(entry.mealId)) continue; // deleted/disabled — auto-drop
        throw SchedulesService.entryMealInvalid(
          entry.mealId,
          toDayOfWeek(date),
          entry.mealName ?? null,
          'meal not found in this group',
        );
      }
      validatedEntries.push({
        id: entry.id,
        mealId: entry.mealId,
        dayOfWeek: toDayOfWeek(date),
        date,
        // Live-Test-6 ISSUE-3 (user decision 2026-07-17): meal NAME and meal
        // IMAGE are editable ONLY in the Master Meal Template. Day entries
        // always inherit both (serializer falls back to the master values),
        // so any client-sent override is coerced to null at the single write
        // point. Operational per-day overrides (price, window, preferences,
        // menu items, notes, description) remain exactly as before.
        mealName: null,
        notes: entry.notes ?? null,
        description: entry.description ?? null,
        imageUrl: null,
        openTime: entry.attendanceWindow?.openTime ?? null,
        closeTime: entry.attendanceWindow?.closeTime ?? null,
        preferencesEnabled: entry.preferencesEnabled ?? null,
        enabledPreferences: entry.enabledPreferences ?? [],
        enabledPreferenceGroupIds: entry.enabledPreferenceGroupIds ?? [],
        menuItems: entry.menuItems ?? [],
        price: entry.price ?? null,
      });
    }

    return validatedEntries;
  }

  // ── FR-MEAL-032 helpers (ISSUE-4 / ISSUE-11) ───────────────────────────────

  /** Practical upper bound on meals per group for the one-shot catalogue load. */
  private static readonly MAX_GROUP_MEALS = 500;

  // Live-Test-5 ISSUE-5: activeMealIds() was removed — the publish self-heal
  // now detects stale entries at the DB level (schedulesRepo.findStaleEntries)
  // because the entity view hides them; mealCatalogue below still serves the
  // draft-validation path.

  /**
   * SRS Module 03 MMT-011: full meal catalogue split into active vs known —
   * an entry whose meal is KNOWN but inactive (deleted/disabled after
   * drafting) is auto-dropped, not an error; an entry whose meal is entirely
   * unknown to the group is a genuine client error and still rejects.
   */
  private async mealCatalogue(
    groupId: string,
    organizationId: string,
  ): Promise<{ active: Set<string>; known: Set<string> }> {
    const catalogue = await this.mealsRepo.findByGroup(groupId, organizationId, {
      page: 1,
      limit: SchedulesService.MAX_GROUP_MEALS,
      includeDisabled: true,
    });
    return {
      active: new Set(
        catalogue.data.filter((m) => m.isActive).map((m) => m.id),
      ),
      known: new Set(catalogue.data.map((m) => m.id)),
    };
  }

  /**
   * Actionable 422 for an invalid schedule entry — identifies the day and the
   * meal plus a stable machine-readable code, so the client can show
   * "Tuesday · Lunch · meal not found" instead of a generic "Meal Invalid".
   */
  private static entryMealInvalid(
    mealId: string,
    dayOfWeek: number,
    mealName: string | null,
    reason: string,
  ): UnprocessableEntityException {
    const day = DAY_LABELS[dayOfWeek] ?? `Day ${dayOfWeek + 1}`;
    const label =
      mealName && mealName.trim().length > 0 ? mealName.trim() : mealId;
    return new UnprocessableEntityException({
      message: `${day} · ${label} · ${reason}`,
      code: 'SCHEDULE_ENTRY_MEAL_INVALID',
      errors: { day, mealId, reason },
    });
  }
}
