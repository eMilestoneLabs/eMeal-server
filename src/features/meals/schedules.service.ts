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
import {
  SchedulesRepository,
  PublishPreferenceContext,
  EffectivePublishedGroup,
  PublishedPlannerMode,
} from './repositories/schedules.repository';
import { PreferencesService } from '../preferences/preferences.service';
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
import {
  assertMealWindowsValid,
  type MealWindowRef,
} from './utils/window-conflict.util';

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
    // P-01 (Live-Test-15): the ONE effective-preference resolver (Module 36),
    // reused at publish time so the frozen snapshot is built by the same code
    // that renders preferences — no duplicated business logic.
    //
    // @Optional + explicit @Inject follows the established convention here
    // (REALTIME_GATEWAY, RedisService above) — the `| null` union erases
    // `design:paramtypes`, so the token is mandatory, not decorative.
    //
    // CAVEAT, deliberately recorded: unlike realtime/Redis this is NOT a
    // degraded-env side-effect — it is CORE to publishing. If it were ever
    // unwired, Nest would inject null, `publishPreferenceResolver()` would
    // return undefined, and the whole P-01 freeze would silently stop running
    // with no error. `publish-freeze-wiring.spec.ts` exists solely to make
    // that failure loud in CI; do not delete it.
    @Optional()
    @Inject(PreferencesService)
    private readonly preferences: PreferencesService | null = null,
  ) {}

  /**
   * P-01: publish-time resolver handed to the repository. ONE batched query
   * per Publish (an admin action), zero cost on every read path. Returns
   * undefined when Module 36 is not wired, which leaves the snapshot at
   * legacy semantics rather than freezing an empty preference config.
   */
  private publishPreferenceResolver(
    organizationId: string,
  ): PublishPreferenceContext | undefined {
    const prefs = this.preferences;
    if (!prefs?.getEffectiveGroupsForMeals) return undefined;
    return {
      resolve: async (mealIds: string[]) =>
        (await prefs.getEffectiveGroupsForMeals(
          mealIds,
          organizationId,
        )) as unknown as Map<string, EffectivePublishedGroup[]>,
      // DRY: the per-day narrowing rule has exactly ONE implementation
      // (Module 36). The publish path borrows it rather than re-stating it,
      // so the freeze can never drift from what the read path renders.
      narrowByDay: (groups, override) =>
        prefs.applyDayOverride(
          groups as any,
          override,
        ) as unknown as typeof groups,
    };
  }

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
      // Live-Test-16 ISSUE-2 §16: a non-replacing PATCH MERGES — the repo
      // upserts on (schedule, meal, date) and leaves every other row alone. So
      // the rows that survive must be validated together with the incoming
      // ones, or a single conflicting entry would slip past a payload-only
      // check. Rows the payload overwrites (same meal + same date) are dropped
      // from the surviving set so a meal never conflicts with its own old
      // window. Built from `existing`, already fetched above — no extra query.
      const merging = dto.replaceEntries !== true;
      const incoming = new Set(
        (dto.entries ?? []).map(
          (e) => `${e.mealId}|${String(e.date).slice(0, 10)}`,
        ),
      );
      const survivors = merging
        ? (existing.entries ?? [])
            .filter((e: any) => {
              const d =
                e.date instanceof Date ? e.date : new Date(e.date);
              return !incoming.has(
                `${e.mealId}|${d.toISOString().slice(0, 10)}`,
              );
            })
            .map((e: any) => ({
              mealId: e.mealId,
              date: e.date instanceof Date ? e.date : new Date(e.date),
              openTime: e.openTime ?? null,
              closeTime: e.closeTime ?? null,
            }))
        : [];
      entries = await this.buildEntryData(
        existing.groupId,
        organizationId,
        dto.entries,
        survivors,
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
  /**
   * ISSUE-011: is the group's GLOBAL Meal Preferences switch OFF? Optional-
   * chained + fail-safe (unknown ⇒ false = keep preferences) so partial test
   * doubles and legacy groups behave exactly as before.
   */
  /**
   * Live-Test-16 ISSUE-1: the SAME fail-soft group load now also carries
   * `firstSchedulePublishedAt`, so the first-publish lock costs no extra read
   * (`findByIdConfig` selects the whole row). Returns null when the row cannot
   * be resolved — every caller then falls back to the pre-existing behaviour.
   */
  private async loadGroupForPublish(
    groupId: string,
    organizationId: string,
  ): Promise<Record<string, any> | null> {
    try {
      const g = this.groupsRepo.findByIdConfig
        ? await this.groupsRepo.findByIdConfig(groupId, organizationId)
        : await this.groupsRepo.findById(groupId, organizationId);
      return (g as any) ?? null;
    } catch {
      return null;
    }
  }

  /** ISSUE-011: unknown ⇒ false (keep preferences) — unchanged semantics. */
  private static preferencesOff(group: Record<string, any> | null): boolean {
    return group?.preferencesEnabled === false;
  }

  /**
   * P-01: the planner mode being published, frozen into the snapshot so the
   * Day-Wise carry-forward is decided by the PUBLISHED schedule instead of the
   * group's LIVE mode flag (which flips at mode-switch, before publish).
   * Undefined when the group row is unavailable — the snapshot then records no
   * mode and the resolver keeps its historical live-flag behaviour.
   */
  private static plannerModeOf(
    group: Record<string, any> | null,
  ): PublishedPlannerMode | undefined {
    if (!group) return undefined;
    if (group.dayWiseMealsEnabled === true) return 'DAY_WISE';
    if (group.weeklyMenuEnabled === true) return 'WEEKLY';
    return undefined;
  }

  /**
   * Live-Test-16 ISSUE-1 §7/§8: stamp the group's FIRST successful schedule
   * publication. This instant is the permanent Meal-Pricing locking event
   * (`groups.service.updateGroup` reads it), so it is written ONLY after the
   * publish has actually committed — a failed publish throws before this line
   * and never consumes the lock.
   *
   * Cost: skipped entirely once the group is stamped, so it is one indexed
   * UPDATE per group per lifetime, never on re-publish. The `null` WHERE
   * clause makes it idempotent and race-safe under concurrent publishes.
   */
  private async stampFirstPublish(
    group: Record<string, any> | null,
    groupId: string,
    organizationId: string,
    adminId: string,
    requestId?: string,
  ): Promise<void> {
    if (!group || group.firstSchedulePublishedAt) return;
    // Live-Test-16 user-locked Q4: the Meal-Pricing lock is meaningful ONLY in
    // Meal-Enabled mode. An Attendance-Only group can still reach publish when
    // it kept `weeklyMenuEnabled` from a previous meals-ON life (the mode
    // cascade deliberately preserves those flags while meals are OFF), and
    // `PRICING_REQUIRES_MEALS` already blocks pricing there — so stamping it
    // would invent a lock lifecycle with no business meaning.
    if (group.mealsEnabled !== true) return;
    try {
      const stamped = await this.groupsRepo.markFirstSchedulePublished?.(
        groupId,
        organizationId,
      );
      // false = a concurrent publish won the race; undefined = a test double
      // without the method. Neither one stamped, so neither is audited.
      if (stamped !== true) return;
      this.audit.log({
        organizationId,
        actorId: adminId,
        targetId: groupId,
        targetType: 'Group',
        action: 'update',
        metadata: {
          firstSchedulePublished: true,
          mealPricingLocked: true,
          mealPricingEnabled: group.mealPricingEnabled === true,
          billingCycleStartDay: group.billingCycleStartDay ?? null,
        },
        requestId,
      });
    } catch (err) {
      // Never fail an already-committed publish. Logged (never swallowed
      // silently) and self-healing: the next publish re-attempts the stamp.
      this.logger.error(
        `First-publish stamp failed for group=${groupId} org=${organizationId} — pricing lock not yet consumed; will retry on next publish`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

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
    // Live-Test-16 ISSUE-1: resolved once per publish and reused for the
    // preference strip AND the first-publish stamp (no second group read).
    let publishGroup: Record<string, any> | null = null;
    let publishGroupId: string | null = null;
    if (dto?.entries !== undefined) {
      const existing = await this.schedulesRepo.findById(id, organizationId);
      if (!existing) {
        throw new NotFoundException({
          message: 'Schedule not found',
          errors: { id: 'Schedule does not exist in your organization' },
        });
      }
      // Live-Test-16 ISSUE-2 §17: buildEntryData validates the effective
      // attendance windows, so a week with a missing or overnight window can
      // never reach replaceAndPublish.
      const entries = await this.buildEntryData(
        existing.groupId,
        organizationId,
        dto.entries,
      );
      // ISSUE-011: Global Meal Preferences OFF ⇒ the published snapshot goes
      // out preference-free — the moment members receive this publish, no
      // meal shows/demands preference picks (Global overrides every meal).
      publishGroupId = existing.groupId;
      publishGroup = await this.loadGroupForPublish(
        existing.groupId,
        organizationId,
      );
      const stripPrefs = SchedulesService.preferencesOff(publishGroup);
      schedule = await this.schedulesRepo.replaceAndPublish(
        id,
        organizationId,
        entries,
        stripPrefs,
        this.publishPreferenceResolver(organizationId),
        SchedulesService.plannerModeOf(publishGroup),
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
      // Live-Test-16 ISSUE-2 §17: the flag-flip publish carries no entries, so
      // it never passes through buildEntryData — validate the PERSISTED rows
      // here instead, using the entries already fetched above (each one joins
      // its master meal's window, so this costs no query). An invalid week can
      // therefore never become the effective published schedule on ANY path.
      this.assertEntryWindows(
        (existing.entries ?? []).map((e: any) => ({
          mealId: e.mealId,
          openTime: e.openTime ?? null,
          closeTime: e.closeTime ?? null,
        })),
        new Map(
          (existing.entries ?? []).map((e: any) => [
            e.mealId,
            {
              mealId: e.mealId,
              label:
                e.meal?.displayName?.trim() ||
                e.meal?.name ||
                e.mealName ||
                e.mealId,
              slotKey: e.meal?.slotKey ?? null,
              openTime: e.meal?.attendanceWindowOpen ?? null,
              closeTime: e.meal?.attendanceWindowClose ?? null,
            } as MealWindowRef,
          ]),
        ),
      );
      // ISSUE-011: same Global-OFF strip on the plain flag-flip publish.
      publishGroupId = existing.groupId;
      publishGroup = await this.loadGroupForPublish(
        existing.groupId,
        organizationId,
      );
      const stripPrefs = SchedulesService.preferencesOff(publishGroup);
      schedule = await this.schedulesRepo.publish(
        id,
        organizationId,
        stripPrefs,
        this.publishPreferenceResolver(organizationId),
        SchedulesService.plannerModeOf(publishGroup),
      );
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

    // Live-Test-16 ISSUE-1 §8: the publish has COMMITTED — only now may the
    // permanent Meal-Pricing decision be locked in.
    //
    // Deliberately LAST and fail-soft (guidebook §3 pattern 4). An earlier
    // placement made a stamp failure abort the realtime emit AND the
    // today-bundle invalidation of an ALREADY-PUBLISHED week — students would
    // have kept a stale overlay while the admin was told the publish failed.
    // A missed stamp is self-healing (the next publish re-stamps, because the
    // UPDATE is guarded by `firstSchedulePublishedAt: null`); a missed cache
    // invalidation is not. Correctness of the published week wins.
    await this.stampFirstPublish(
      publishGroup,
      publishGroupId ?? (schedule as any)?.groupId,
      organizationId,
      adminId,
      requestId,
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
    // Live-Test-16 ISSUE-2 §16: entries that will SURVIVE this write and must
    // therefore be validated alongside the incoming ones. PATCH /schedules/:id
    // defaults to `replaceEntries:false` (merge), so validating only the
    // payload would let a direct API call persist a draft that conflicts with
    // rows it never mentions. Empty for every replace/create path.
    mergeWith: ReadonlyArray<{
      mealId: string;
      date: Date;
      openTime: string | null;
      closeTime: string | null;
    }> = [],
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
    const { active, known, byId } = await this.mealCatalogue(
      groupId,
      organizationId,
    );

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

    // Live-Test-16 ISSUE-2: ONE funnel — POST /schedules, POST
    // /meals/weekly-schedule, PATCH /schedules/:id and the replace-and-publish
    // path all build their entries here, so validating once covers every one
    // of them with no duplicated logic and no extra query. `mergeWith` carries
    // the rows a partial (non-replacing) PATCH would leave in place; `byId` is
    // the whole group catalogue, so their master windows resolve from the same
    // map with no additional read.
    this.assertEntryWindows([...mergeWith, ...validatedEntries], byId);

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
  ): Promise<{
    active: Set<string>;
    known: Set<string>;
    // Live-Test-16 ISSUE-2: master window + label per meal, riding the SAME
    // query the catalogue already performs (guidebook §3b rule 3 — "ride the
    // include"). A day entry with no per-day override inherits these values,
    // so the effective-window validation needs no extra wave.
    byId: Map<string, MealWindowRef>;
  }> {
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
      byId: new Map(
        catalogue.data.map((m) => [
          m.id,
          {
            mealId: m.id,
            label: m.displayName?.trim() || m.name,
            slotKey: m.slotKey,
            openTime: m.attendanceWindowOpen ?? null,
            closeTime: m.attendanceWindowClose ?? null,
          } as MealWindowRef,
        ]),
      ),
    };
  }

  /**
   * Live-Test-16 ISSUE-2: assert the attendance-window invariant PER DATE.
   *
   * The effective window of a day entry is its per-day override, else the
   * master meal template window. Validation is linear within each date — the
   * next calendar date starts a new attendance lifecycle, so today's last
   * window is never compared against tomorrow's first one (user-locked Q8).
   *
   * Pure in-process work over rows the caller already holds: no query.
   */
  private assertEntryWindows(
    entries: ReadonlyArray<{
      mealId: string;
      openTime: string | null;
      closeTime: string | null;
    }>,
    byId: Map<string, MealWindowRef>,
  ): void {
    if (entries.length === 0) return;
    // Windows are validated INDIVIDUALLY (present + same-day). They are never
    // compared with one another, so concurrent windows on the same date are
    // allowed and no per-date grouping is needed.
    assertMealWindowsValid(
      entries.map((e) => {
        const master = byId.get(e.mealId);
        return {
          mealId: e.mealId,
          label: master?.label ?? e.mealId,
          slotKey: master?.slotKey ?? null,
          openTime: e.openTime ?? master?.openTime ?? null,
          closeTime: e.closeTime ?? master?.closeTime ?? null,
        };
      }),
    );
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
