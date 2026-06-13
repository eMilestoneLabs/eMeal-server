import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  HttpException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../../audit/audit.service';
import { AttendanceRepository } from './repositories/attendance.repository';
import { MembersRepository } from '../groups/repositories/members.repository';
import {
  toUtcMidnight,
  getCurrentTimeInTimezone,
  isWithinWindow,
} from '../../common/utils/date.utils';
import {
  AttendanceSerializer,
  AttendanceSummarySerializer,
  MealAttendanceSummarySerializer,
} from './serializers/attendance.serializer';
import {
  AttendanceSummaryEntity,
  MealAttendanceSummaryEntity,
} from './entities/attendance.entity';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { BulkAttendanceDto } from './dto/bulk-attendance.dto';
import { AdminOverrideDto } from './dto/admin-override.dto';
import {
  QueryAttendanceDto,
  QuerySummaryDto,
  QueryMealSummaryDto,
} from './dto/query-attendance.dto';

/** Admin role names — same set as used in groups + meals guards. */
const ADMIN_ROLES = [
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
];

// ─── Cache key patterns ──────────────────────────────────────────────────────
// TTL = 5 minutes (300s) — short enough for operational dashboards
const CACHE_TTL = 300;

function summaryKey(orgId: string, userId: string, groupId: string) {
  return `attendance:summary:${orgId}:${userId}:${groupId}`;
}
function mealSummaryKey(orgId: string, mealId: string, date: string) {
  return `attendance:meal:${orgId}:${mealId}:${date}`;
}
function groupDaySummaryKey(orgId: string, groupId: string, date: string) {
  return `attendance:group:${orgId}:${groupId}:${date}`;
}

// ─── Timezone helper (local-only, not in shared utils) ───────────────────────

/**
 * Get today's date as YYYY-MM-DD in the given IANA timezone.
 * Used to compute the attendance date when a student marks attendance
 * (the date in their local timezone, not the server timezone).
 */
function getTodayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Shared date utils (toUtcMidnight, getCurrentTimeInTimezone, isWithinWindow)
// are imported from src/common/utils/date.utils.ts

// ─── AttendanceService ────────────────────────────────────────────────────────

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attendanceRepo: AttendanceRepository,
    private readonly membersRepo: MembersRepository,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    // Gateway injected optionally — avoids circular dep if realtime module loads after
    // Use ATTENDANCE_GATEWAY token to break the circular dependency safely
    @Optional() @Inject('ATTENDANCE_GATEWAY')
    private readonly gateway: {
      emitToGroup(groupId: string, event: string, payload: unknown): void;
      emitToUser(userId: string, event: string, payload: unknown): void;
    } | null,
  ) {}

  // ── Mark attendance (student) ─────────────────────────────────────────────

  async markAttendance(
    userId: string,
    organizationId: string,
    dto: MarkAttendanceDto,
    requestId?: string,
  ) {
    // 1. Load meal with org isolation — timezone comes from Organization, not Group
    const meal = await this.prisma.meal.findFirst({
      where: { id: dto.mealId, organizationId },
      include: {
        group: { select: { id: true, mealsEnabled: true } },
        organization: { select: { timezone: true } },
      },
    });

    if (!meal) {
      throw new NotFoundException('Meal not found');
    }

    // 2. Verify meal attendance is enabled
    if (!meal.attendanceEnabled) {
      throw new BadRequestException('Attendance is not enabled for this meal');
    }

    // 3. Verify student is an active member of this group
    const member = await this.membersRepo.isActiveMember(meal.groupId, userId);
    if (!member) {
      throw new ForbiddenException(
        'You are not an active member of this group',
      );
    }

    // 4. Vacation mode check — read from user record
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isVacationMode: true },
    });

    const status = dto.status ?? 'present';

    if (user?.isVacationMode && status !== 'onVacation') {
      // During vacation mode, auto-set status to onVacation instead of blocking
      // (student may still mark but we override to onVacation if active)
      this.logger.debug(
        `User ${userId} is in vacation mode — status remains present but flagged`,
      );
    }

    // 5. Attendance window validation (using org timezone — from Organization, not Group)
    const orgTimezone = meal.organization?.timezone ?? 'Asia/Kolkata';
    const todayInTz = getTodayInTimezone(orgTimezone);
    const attendanceDate = dto.attendanceDate;

    // Students can only mark for today (admin override bypasses this)
    if (attendanceDate !== todayInTz) {
      throw new BadRequestException(
        `Attendance can only be marked for today (${todayInTz})`,
      );
    }

    // Check within attendance window
    if (meal.attendanceWindowOpen && meal.attendanceWindowClose) {
      const currentTime = getCurrentTimeInTimezone(orgTimezone);
      const withinWindow = isWithinWindow(
        currentTime,
        meal.attendanceWindowOpen,
        meal.attendanceWindowClose,
      );

      if (!withinWindow) {
        // GAP-ATT-1 (RESOLVED): source-of-truth requires HTTP 423 (Locked) for
        // out-of-window marks. Flat error contract (LAW-12), same message text.
        throw new HttpException(
          {
            message: `Attendance window closed. Window: ${meal.attendanceWindowOpen}–${meal.attendanceWindowClose}`,
            errors: { window: `Closed at ${meal.attendanceWindowClose}` },
            statusCode: 423,
          },
          423,
        );
      }
    }

    // 6. Upsert attendance (idempotent)
    const attendanceDateUtc = toUtcMidnight(attendanceDate);
    const record = await this.attendanceRepo.upsert({
      organizationId,
      groupId: meal.groupId,
      userId,
      mealId: dto.mealId,
      attendanceDate: attendanceDateUtc,
      status,
      preference: dto.preference ?? null,
      note: dto.note ?? null,
      markedAt: new Date(),
      markedBy: null, // student marks own attendance
    });

    // 7. Invalidate Redis cache
    await this.invalidateAttendanceCache(
      organizationId,
      userId,
      meal.groupId,
      attendanceDate,
      dto.mealId,
    );

    // 8. Emit realtime event (marked.v1 = new mark, updated.v1 = re-mark)
    this.emitAttendanceUpdated(meal.groupId, record, organizationId, true);

    // 9. Audit log (fire-and-forget)
    this.audit.log({
      organizationId,
      actorId: userId,
      targetId: record.id,
      targetType: 'Attendance',
      action: AuditAction.create,
      requestId,
    });

    return AttendanceSerializer.toMarkResponse(record);
  }

  // ── Bulk mark attendance (student) ────────────────────────────────────────

  async bulkMarkAttendance(
    userId: string,
    organizationId: string,
    dto: BulkAttendanceDto,
    requestId?: string,
  ) {
    // Validate all mealIds belong to this org
    const mealIds = [...new Set(dto.entries.map((e) => e.mealId))];
    const meals = await this.prisma.meal.findMany({
      where: { id: { in: mealIds }, organizationId },
      select: { id: true, groupId: true, attendanceEnabled: true },
    });

    if (meals.length !== mealIds.length) {
      throw new BadRequestException(
        'One or more meals not found or not accessible',
      );
    }

    // All meals must have attendanceEnabled
    const disabledMeal = meals.find((m) => !m.attendanceEnabled);
    if (disabledMeal) {
      throw new BadRequestException(
        `Attendance is not enabled for meal: ${disabledMeal.id}`,
      );
    }

    const mealMap = new Map(meals.map((m) => [m.id, m]));

    const entries = dto.entries.map((e) => {
      const meal = mealMap.get(e.mealId)!;
      return {
        organizationId,
        groupId: meal.groupId,
        userId,
        mealId: e.mealId,
        attendanceDate: toUtcMidnight(e.attendanceDate),
        status: e.status ?? 'present',
        preference: e.preference ?? null,
        note: e.note ?? null,
        markedAt: new Date(),
        markedBy: null,
      };
    });

    const records = await this.attendanceRepo.bulkUpsert(entries);

    // Invalidate cache for all affected groups/dates
    const toDateStr = (d: Date) => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const affected = new Set(
      records.map((r) => `${r.groupId}:${toDateStr(r.attendanceDate)}`),
    );

    await Promise.all(
      [...affected].map(async (key) => {
        const [groupId, date] = key.split(':');
        await this.invalidateAttendanceCache(
          organizationId,
          userId,
          groupId,
          date,
          undefined,
        );
      }),
    );

    return {
      count: records.length,
      records: records.map((r) => AttendanceSerializer.toMarkResponse(r)),
    };
  }

  // ── Admin override — bypasses window + vacation mode ─────────────────────

  async adminOverride(
    adminId: string,
    organizationId: string,
    dto: AdminOverrideDto,
    requestId?: string,
  ) {
    // 1. Verify meal exists in org
    const meal = await this.prisma.meal.findFirst({
      where: { id: dto.mealId, organizationId },
      select: { id: true, groupId: true },
    });
    if (!meal) throw new NotFoundException('Meal not found');

    // 2. Verify target user belongs to org
    const targetUser = await this.prisma.user.findFirst({
      where: { id: dto.userId, organizationId },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundException('User not found in organization');

    // 3. Admin override bypasses window validation and vacation mode
    const attendanceDateUtc = toUtcMidnight(dto.attendanceDate);
    const record = await this.attendanceRepo.upsert({
      organizationId,
      groupId: meal.groupId,
      userId: dto.userId,
      mealId: dto.mealId,
      attendanceDate: attendanceDateUtc,
      status: dto.status,
      preference: dto.preference ?? null,
      note: dto.note ?? null,
      markedAt: new Date(),
      markedBy: adminId, // tracks who performed override
    });

    // 4. Invalidate cache
    await this.invalidateAttendanceCache(
      organizationId,
      dto.userId,
      meal.groupId,
      dto.attendanceDate,
      dto.mealId,
    );

    // 5. Emit realtime — attendance.updated.v1 (backward compat) PLUS
    // attendance.overridden.v1 (GAP-WS-1: source-of-truth event name)
    this.emitAttendanceUpdated(meal.groupId, record, organizationId);
    this.emitAttendanceOverridden(meal.groupId, record);

    // 6. Audit
    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: record.id,
      targetType: 'Attendance',
      action: AuditAction.update,
      metadata: { override: true, targetUserId: dto.userId },
      requestId,
    });

    return AttendanceSerializer.toMarkResponse(record);
  }

  // ── Get attendance history (paginated) ────────────────────────────────────

  async getAttendance(
    requesterId: string,
    requesterRole: string,
    organizationId: string,
    query: QueryAttendanceDto,
  ) {
    const isAdmin = ADMIN_ROLES.includes(requesterRole);

    // Students always see only their own records
    const userId = isAdmin ? query.userId : requesterId;

    const fromDate = query.fromDate ? toUtcMidnight(query.fromDate) : undefined;
    const toDate = query.toDate ? toUtcMidnight(query.toDate) : undefined;

    if (userId && !isAdmin) {
      // Student path — scoped by userId
      const result = await this.attendanceRepo.findByUser(userId, organizationId, {
        groupId: query.groupId,
        mealId: query.mealId,
        fromDate,
        toDate,
        status: query.status,
        page: query.page,
        limit: query.limit,
      });
      return {
        data: result.data.map((r) => AttendanceSerializer.toResponse(r)),
        total: result.total,
        page: result.page,
        limit: result.limit,
      };
    }

    // Admin path — scoped by group
    if (!query.groupId) {
      throw new BadRequestException('groupId is required for admin queries');
    }

    const result = await this.attendanceRepo.findByGroup(
      query.groupId,
      organizationId,
      {
        mealId: query.mealId,
        userId,
        fromDate,
        toDate,
        status: query.status,
        page: query.page,
        limit: query.limit,
      },
    );

    return {
      data: result.data.map((r) => AttendanceSerializer.toResponse(r)),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  // ── User attendance summary ───────────────────────────────────────────────

  async getUserSummary(
    requesterId: string,
    requesterRole: string,
    organizationId: string,
    query: QuerySummaryDto,
  ) {
    const isAdmin = ADMIN_ROLES.includes(requesterRole);
    const userId = isAdmin && query.userId ? query.userId : requesterId;

    // Default to last 30 days if no date range given
    const toDate = query.toDate
      ? toUtcMidnight(query.toDate)
      : new Date();
    const fromDate = query.fromDate
      ? toUtcMidnight(query.fromDate)
      : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const fromStr = fromDate.toISOString().slice(0, 10);
    const toStr = toDate.toISOString().slice(0, 10);

    // Try cache (5min TTL)
    const cacheKey = summaryKey(organizationId, userId, query.groupId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Cache corrupted — fall through to DB
      }
    }

    const counts = await this.attendanceRepo.getUserSummary(
      userId,
      query.groupId,
      organizationId,
      fromDate,
      toDate,
    );

    const summary = new AttendanceSummaryEntity({
      userId,
      groupId: query.groupId,
      organizationId,
      fromDate: fromStr,
      toDate: toStr,
      ...counts,
    });

    const response = AttendanceSummarySerializer.toResponse(summary);

    // Cache result
    await this.redis.set(cacheKey, JSON.stringify(response), CACHE_TTL);

    return response;
  }

  // ── Meal attendance summary (admin) ──────────────────────────────────────

  async getMealSummary(
    organizationId: string,
    query: QueryMealSummaryDto,
  ) {
    const meal = await this.prisma.meal.findFirst({
      where: { id: query.mealId, organizationId },
      select: { id: true, slotKey: true, name: true, displayName: true, groupId: true },
    });
    if (!meal) throw new NotFoundException('Meal not found');

    const attendanceDateUtc = toUtcMidnight(query.date);

    // Try cache
    const cacheKey = mealSummaryKey(organizationId, query.mealId, query.date);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch { /* fall through */ }
    }

    // Total active members for this group (for totalMembers field)
    const totalMembers = await this.prisma.groupMember.count({
      where: { groupId: meal.groupId, status: 'active' },
    });

    const counts = await this.attendanceRepo.getMealSummary(
      query.mealId,
      organizationId,
      attendanceDateUtc,
    );

    const summaryEntity = new MealAttendanceSummaryEntity({
      mealId: meal.id,
      slotKey: meal.slotKey,
      displayName: meal.displayName ?? meal.name,
      attendanceDate: query.date,
      totalMembers,
      presentCount: counts.presentCount,
      absentCount: counts.absentCount,
      skippedCount: counts.skippedCount,
      preferenceBreakdown: counts.preferenceBreakdown,
    });

    const response = MealAttendanceSummarySerializer.toResponse(summaryEntity);

    // Cache result
    await this.redis.set(cacheKey, JSON.stringify(response), CACHE_TTL);

    return response;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async invalidateAttendanceCache(
    organizationId: string,
    userId: string,
    groupId: string,
    date: string,
    mealId?: string,
  ): Promise<void> {
    const keysToDelete: string[] = [
      summaryKey(organizationId, userId, groupId),
      groupDaySummaryKey(organizationId, groupId, date),
    ];

    if (mealId) {
      keysToDelete.push(mealSummaryKey(organizationId, mealId, date));
    }

    await this.redis.del(...keysToDelete);
  }

  private emitAttendanceUpdated(
    groupId: string,
    record: any,
    organizationId: string,
    isNew = false,
  ): void {
    if (!this.gateway) return;

    try {
      // B7 governance: use attendance.marked.v1 for first-time marks,
      // attendance.updated.v1 for admin overrides / re-marks
      const eventName = isNew ? 'attendance.marked.v1' : 'attendance.updated.v1';
      this.gateway.emitToGroup(groupId, eventName, {
        groupId,
        userId: record.userId,
        mealId: record.mealId,
        attendanceDate: record.attendanceDate.toISOString().slice(0, 10),
        status: record.status,
        markedBy: record.markedBy ?? null,
      });
    } catch (err) {
      // Never let gateway failure break the HTTP response
      this.logger.warn(`Gateway emit failed: ${err?.message}`);
    }
  }

  /**
   * GAP-WS-1 (RESOLVED): attendance.overridden.v1 — fired ONLY for admin
   * overrides, in addition to attendance.updated.v1. Group room for live
   * admin dashboards + the affected user's room so their history refreshes
   * ("Your attendance was updated by an administrator").
   */
  private emitAttendanceOverridden(groupId: string, record: any): void {
    if (!this.gateway) return;

    try {
      const payload = {
        groupId,
        userId: record.userId,
        mealId: record.mealId,
        attendanceDate: record.attendanceDate.toISOString().slice(0, 10),
        status: record.status,
        markedBy: record.markedBy ?? null,
      };
      this.gateway.emitToGroup(groupId, 'attendance.overridden.v1', payload);
      this.gateway.emitToUser(record.userId, 'attendance.overridden.v1', payload);
    } catch (err) {
      this.logger.warn(`Gateway emit failed: ${err?.message}`);
    }
  }
}
