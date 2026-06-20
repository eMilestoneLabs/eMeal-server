import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
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
  ) {}

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

    const group = await this.groupsRepo.findById(query.groupId, organizationId);
    if (!group) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    // Students see published schedules only
    const publishedOnly = !isAdmin || !!query.publishedOnly;

    const result = await this.schedulesRepo.findByGroup(query.groupId, organizationId, {
      page,
      limit,
      publishedOnly,
    });

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
    const schedule = await this.schedulesRepo.findById(id, organizationId);
    if (!schedule) {
      throw new NotFoundException({
        message: 'Schedule not found',
        errors: { id: 'Schedule does not exist in your organization' },
      });
    }

    const isAdmin = ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'].includes(role);

    // Students can only view published schedules
    if (!isAdmin && !schedule.isPublished) {
      throw new NotFoundException({
        message: 'Schedule not found',
        errors: { id: 'Schedule is not yet published' },
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

    if (existing.isPublished) {
      throw new BadRequestException({
        message: 'Cannot edit a published schedule',
        errors: { id: 'Unpublish the schedule before making changes' },
      });
    }

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
  ) {
    const schedule = await this.schedulesRepo.publish(id, organizationId);

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
  ) {
    const schedule = await this.schedulesRepo.revert(id, organizationId);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'MealSchedule',
      action: 'update',
      metadata: { published: false, weekStartDate: schedule.weekStart.toISOString() },
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

    const cloned = await this.schedulesRepo.clone(sourceId, organizationId, targetWeekStart);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: cloned.id,
      targetType: 'MealSchedule',
      action: 'create',
      metadata: { clonedFrom: sourceId, targetWeekStartDate: dto.targetWeekStartDate },
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
      attendanceWindow?: { openTime: string; closeTime: string } | null;
      preferencesEnabled?: boolean | null;
      enabledPreferences?: string[] | null;
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
      openTime: string | null;
      closeTime: string | null;
      preferencesEnabled: boolean | null;
      enabledPreferences: string[];
      menuItems: string[];
      price: number | null;
    }> = [];

    for (const entry of entriesDto) {
      // Verify mealId belongs to this group and org
      const isValid = await this.mealsRepo.verifyGroupOwnership(
        entry.mealId,
        groupId,
        organizationId,
      );
      if (!isValid) {
        throw new BadRequestException({
          message: 'Invalid mealId in entries',
          errors: { mealId: `Meal ${entry.mealId} does not belong to this group` },
        });
      }

      const date = parseLocalDate(entry.date);
      validatedEntries.push({
        id: entry.id,
        mealId: entry.mealId,
        dayOfWeek: toDayOfWeek(date),
        date,
        mealName: entry.mealName ?? null,
        notes: entry.notes ?? null,
        openTime: entry.attendanceWindow?.openTime ?? null,
        closeTime: entry.attendanceWindow?.closeTime ?? null,
        preferencesEnabled: entry.preferencesEnabled ?? null,
        enabledPreferences: entry.enabledPreferences ?? [],
        menuItems: entry.menuItems ?? [],
        price: entry.price ?? null,
      });
    }

    return validatedEntries;
  }
}
