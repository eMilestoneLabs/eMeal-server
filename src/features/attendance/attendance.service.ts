import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
  HttpException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../../audit/audit.service';
import { AttendanceRepository } from './repositories/attendance.repository';
import { MembersRepository } from '../groups/repositories/members.repository';
import { PreferencesService } from '../preferences/preferences.service';
import { BillingService } from '../billing/billing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { GuestsService } from '../guests/guests.service';
import {
  toUtcMidnight,
  getCurrentTimeInTimezone,
  isWithinWindow,
  getWindowState,
  formatUtcDate,
  AttendanceWindowState,
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
import { AdminOverrideDto, AdminBulkOverrideDto } from './dto/admin-override.dto';
import {
  QueryAttendanceDto,
  QuerySummaryDto,
  QueryMealSummaryDto,
  QueryBillingDto,
  QueryBillingSeriesDto,
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
    private readonly config: ConfigService,
    private readonly preferencesService: PreferencesService,
    // Gateway injected optionally — avoids circular dep if realtime module loads after
    // Use ATTENDANCE_GATEWAY token to break the circular dependency safely
    @Optional() @Inject('ATTENDANCE_GATEWAY')
    private readonly gateway: {
      emitToGroup(groupId: string, event: string, payload: unknown): void;
      emitToUser(userId: string, event: string, payload: unknown): void;
    } | null,
    // Pass 7 (FR-DISP-010): period-lock guard. Optional so existing unit-test
    // modules without the billing provider keep working; production wiring
    // always provides it via BillingModule. Explicit @Inject — a `| null`
    // union erases the emitted param-type metadata.
    @Optional() @Inject(BillingService)
    private readonly billing: BillingService | null,
    // Pass 7 (FR-TRUST-011): proactive member notify on non-self changes.
    @Optional() @Inject(NotificationsService)
    private readonly notifications: NotificationsService | null,
    // Pass 8 (FR-HG-035/060): hosted-guest reconciliation + kitchen counts.
    @Optional() @Inject(GuestsService)
    private readonly guests: GuestsService | null,
  ) {}

  /**
   * Module 22 (FR-HG-035): when a host's status flips away from Present,
   * their booked guests are cancelled with them (unless the group allows
   * hostless guests). Fire-and-forget — reconciliation never fails a mark.
   */
  private reconcileGuests(params: {
    organizationId: string;
    groupId: string;
    hostUserId: string;
    mealId: string;
    attendanceDate: Date;
    newStatus: string;
    actorId: string;
    requestId?: string;
  }): void {
    if (params.newStatus === 'present') return;
    void this.guests?.reconcileOnHostChange(params);
  }

  /**
   * SRS FR-DISP-010 (LOOP-014): attendance/billing writes into a FINALIZED
   * billing period are rejected — post-lock changes require an explicit,
   * audited reopen. 423 with a machine-readable code, same flat contract.
   */
  private async assertPeriodNotFinalized(
    organizationId: string,
    groupId: string,
    dateStr: string,
  ): Promise<void> {
    if (!this.billing) return;
    const { locked, periodEnd } = await this.billing.isDateFinalized(
      organizationId,
      groupId,
      toUtcMidnight(dateStr),
    );
    if (locked) {
      throw new HttpException(
        {
          message:
            'This billing period is finalized — reopen it before changing attendance',
          code: 'PERIOD_FINALIZED',
          errors: { attendanceDate: `Locked through ${periodEnd}` },
          serverTime: new Date().toISOString(),
          statusCode: 423,
        },
        423,
      );
    }
  }

  /**
   * Resolves the ₹ price that applies to a meal on a date: the per-day published
   * schedule entry price OVERRIDES the master meal price. Snapshotted onto the
   * attendance record so billing/exports reflect what the member actually saw.
   */
  private async resolveEffectiveMealPrice(
    mealId: string,
    groupId: string,
    organizationId: string,
    attendanceDate: string,
    masterPrice: number | null,
  ): Promise<number | null> {
    const effective = await this.resolveEffectiveWindow(
      mealId,
      groupId,
      organizationId,
      attendanceDate,
      { openTime: null, closeTime: null, price: masterPrice },
    );
    return effective.price;
  }

  /**
   * Resolves the EFFECTIVE attendance window + price for a meal on a date:
   * the per-day published schedule entry (exact date, else recurring weekday)
   * overrides the master meal values — matching exactly what the student sees
   * on GET /meals/today. Public so the corrections module (Module 33) enforces
   * the same window semantics as marking itself.
   */
  async resolveEffectiveWindow(
    mealId: string,
    groupId: string,
    organizationId: string,
    dateStr: string,
    master: {
      openTime: string | null;
      closeTime: string | null;
      price: number | null;
    },
  ): Promise<{
    openTime: string | null;
    closeTime: string | null;
    price: number | null;
    /** SRS FR-MODE-032: whether a published entry schedules this meal today. */
    scheduledToday: boolean;
  }> {
    const dateUtc = toUtcMidnight(dateStr);
    const dow = (dateUtc.getUTCDay() + 6) % 7;
    let entry = await this.prisma.scheduleEntry.findFirst({
      where: {
        mealId,
        date: dateUtc,
        schedule: { groupId, organizationId, isPublished: true },
      },
      select: { openTime: true, closeTime: true, price: true },
    });
    if (!entry) {
      entry = await this.prisma.scheduleEntry.findFirst({
        where: {
          mealId,
          dayOfWeek: dow,
          schedule: { groupId, organizationId, isPublished: true },
        },
        orderBy: { schedule: { weekStart: 'desc' } },
        select: { openTime: true, closeTime: true, price: true },
      });
    }
    return {
      openTime: entry?.openTime ? entry.openTime : master.openTime,
      closeTime: entry?.openTime ? entry.closeTime : master.closeTime,
      price: entry?.price != null ? entry.price : master.price,
      scheduledToday: !!entry,
    };
  }

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
        group: {
          select: {
            id: true,
            mealsEnabled: true,
            // Pass 6: planner flags (FR-MODE-032 holiday guard) + grace
            // period (FR-TIME-005) ride the same query — no extra round-trip.
            weeklyMenuEnabled: true,
            dayWiseMealsEnabled: true,
            attendanceGraceMinutes: true,
            // Pass 10 (FR-MEMX-006/SC-006): archived-group state re-checked
            // at write time — rides the same query, no extra round-trip.
            isActive: true,
          },
        },
        organization: { select: { timezone: true } },
      },
    });

    if (!meal) {
      throw new NotFoundException('Meal not found');
    }

    // Pass 10 (FR-GRP-014/FR-MEMX-006, LOOP-026): a group archived mid-day
    // rejects in-flight marks — state is server-checked at submit, not UI.
    if (meal.group && meal.group.isActive === false) {
      throw new ForbiddenException({
        message: 'Group access is no longer available',
        code: 'GROUP_ARCHIVED',
        errors: { mealId: 'This group has been archived' },
      });
    }

    // 2. Verify meal attendance is enabled
    if (!meal.attendanceEnabled) {
      throw new BadRequestException('Attendance is not enabled for this meal');
    }

    // 3. Verify membership state at submit (FR-MEMX-002/006): blocked members
    // get the canonical MEMBER_BLOCKED; removed/never-joined stay generic.
    const membership = await this.membersRepo.findMembership(
      meal.groupId,
      userId,
    );
    if (membership?.status === 'blocked') {
      throw new ForbiddenException({
        message: 'You have been blocked from this group and cannot mark attendance',
        code: 'MEMBER_BLOCKED',
        errors: { mealId: 'Contact your group admin' },
      });
    }
    if (!membership || membership.status !== 'active') {
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

    // SRS FR-DISP-010: no writes into a finalized billing period.
    await this.assertPeriodNotFinalized(
      organizationId,
      meal.groupId,
      attendanceDate,
    );

    // SRS FR-CONC-003 (LOOP double-tap): short-TTL Redis NX key de-duplicates
    // rapid re-submits. On a duplicate, the already-written record is returned
    // (idempotent) — no second event/audit is emitted. A first attempt that
    // was REJECTED leaves no record, so the retry falls through to the normal
    // validation path and gets the same canonical error.
    const dedupTtl = this.config.get<number>(
      'attendance.markDedupTtlSeconds',
      3,
    );
    if (dedupTtl > 0) {
      const dedupKey = `att:mark:${userId}:${dto.mealId}:${attendanceDate}:${status}`;
      const firstWriter = await this.redis.setDedup(dedupKey, dedupTtl);
      if (!firstWriter) {
        const existing = await this.prisma.attendanceRecord.findFirst({
          where: {
            organizationId,
            userId,
            mealId: dto.mealId,
            attendanceDate: toUtcMidnight(attendanceDate),
          },
        });
        if (existing && existing.status === status) {
          return AttendanceSerializer.toMarkResponse(existing as any);
        }
      }
    }

    // Per-day window override (Weekly / Day-Wise Meal Mode): a published
    // schedule entry for THIS meal today takes precedence over the master meal
    // window, so enforcement matches exactly what the student sees on
    // GET /meals/today. Falls back to the master window when no schedule applies.
    const effective = await this.resolveEffectiveWindow(
      meal.id,
      meal.groupId,
      organizationId,
      todayInTz,
      {
        openTime: meal.attendanceWindowOpen,
        closeTime: meal.attendanceWindowClose,
        price: meal.price ?? null,
      },
    );
    const effectivePrice = effective.price;
    const effectiveOpen = effective.openTime;
    const effectiveClose = effective.closeTime;

    // SRS FR-MODE-032 (LOOP-094): holiday / no-meal day. When the group runs a
    // planner mode (Weekly / Day-Wise), students see ONLY the published
    // schedule — a meal with no published entry today is a no-meal day and
    // must be unmarkable (and therefore never billed or counted absent).
    // Attendance-only groups (mealsEnabled=false) are exempt: their implicit
    // general slot never appears in schedules.
    const plannerActive =
      meal.group?.mealsEnabled !== false &&
      (meal.group?.weeklyMenuEnabled === true ||
        meal.group?.dayWiseMealsEnabled === true);
    if (plannerActive && !effective.scheduledToday) {
      throw new UnprocessableEntityException({
        message: 'No meal today — this meal is not scheduled for today',
        code: 'NO_MEAL_TODAY',
        errors: { mealId: 'This meal is not scheduled for today' },
      });
    }

    // Check within attendance window (effective = per-day override or master).
    // SRS FR-TIME-002: open-inclusive, close-EXCLUSIVE (LOOP-023).
    // SRS FR-TIME-005: per-group grace extends close (LOOP-090).
    // SRS FR-TIME-008: canonical window state (upcoming/open/grace/closed).
    const graceMinutes = Math.max(
      0,
      meal.group?.attendanceGraceMinutes ?? 0,
    );
    let windowState: AttendanceWindowState = 'open';
    if (effectiveOpen && effectiveClose) {
      const currentTime = getCurrentTimeInTimezone(orgTimezone);
      windowState = getWindowState(
        currentTime,
        effectiveOpen,
        effectiveClose,
        graceMinutes,
      );

      if (windowState === 'upcoming' || windowState === 'closed') {
        // GAP-ATT-1 (RESOLVED): source-of-truth requires HTTP 423 (Locked) for
        // out-of-window marks. Flat error contract (LAW-12), same message text.
        // SRS FR-TIME-011/012 (LOOP-091/092): machine-readable code, close
        // instant and serverTime ride additively so clients reconcile skew and
        // offline replays surface the canonical conflict.
        throw new HttpException(
          {
            message: `Attendance window closed. Window: ${effectiveOpen}–${effectiveClose}`,
            code: 'ATTENDANCE_WINDOW_CLOSED',
            errors: { window: `Closed at ${effectiveClose}` },
            windowState,
            closeTime: effectiveClose,
            graceMinutes,
            serverTime: new Date().toISOString(),
            statusCode: 423,
          },
          423,
        );
      }
    }

    // 5b. Module 36 (FR-PG-031/032/040): when the meal has explicit preference
    // groups and the member marks Present, the selection set is validated
    // server-side and priced (base + Σ delta×qty). Meals WITHOUT explicit
    // groups stay on the legacy flat path untouched (FR-PG-021/100).
    let markPrice = effectivePrice;
    let derivedPreference = dto.preference ?? null;
    let selectionSnapshot: Array<Record<string, unknown>> | undefined;
    let selectionRows:
      | Parameters<AttendanceRepository['upsert']>[0]['selectionRows']
      | undefined;
    if (status === 'present') {
      const pgGroups = await this.preferencesService.getEffectiveGroupsForMeal(
        meal.id,
        organizationId,
      );
      if (pgGroups.length > 0) {
        const validated = this.preferencesService.validateSelections(
          pgGroups,
          dto.selections ?? [],
        );
        // Option deltas bill only when meal pricing is active (base price set);
        // without a base price, selections are recorded but never billed.
        if (effectivePrice != null) {
          markPrice = effectivePrice + validated.totalDelta;
        }
        derivedPreference = dto.preference ?? validated.primaryKey;
        selectionSnapshot = validated.snapshot;
        selectionRows = validated.rows;
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
      preference: derivedPreference,
      note: dto.note ?? null,
      markedAt: new Date(),
      markedBy: null, // student marks own attendance
      price: markPrice,
      source: 'self', // Module 33 consent trail
      ...(selectionRows !== undefined
        ? { preferences: selectionSnapshot, selectionRows }
        : {}),
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

    // Module 22 (FR-HG-035): a host flipping away from Present cancels their
    // booked guests with them (default policy).
    this.reconcileGuests({
      organizationId,
      groupId: meal.groupId,
      hostUserId: userId,
      mealId: dto.mealId,
      attendanceDate: attendanceDateUtc,
      newStatus: status,
      actorId: userId,
      requestId,
    });

    // 9. Audit log (fire-and-forget). Grace marks are auditable (FR-TIME-005)
    // and an offline replay's claimed action time is kept for conflict
    // analysis (FR-CONC-005) — advisory only, never trusted for enforcement.
    this.audit.log({
      organizationId,
      actorId: userId,
      targetId: record.id,
      targetType: 'Attendance',
      action: AuditAction.create,
      metadata: {
        windowState,
        // FR-TRUST-010: status/source ride on every write so the member's
        // change history can render meaningful entries.
        status,
        source: 'self',
        ...(windowState === 'grace'
          ? { markedInGrace: true, graceMinutes, windowClose: effectiveClose }
          : {}),
        ...(dto.clientActionAt ? { clientActionAt: dto.clientActionAt } : {}),
      },
      requestId,
    });

    // FR-TIME-011: serverTime + windowState ride additively on the response
    // so clients reconcile clock skew and disable controls proactively.
    return {
      ...AttendanceSerializer.toMarkResponse(record),
      serverTime: new Date().toISOString(),
      windowState,
    };
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
      select: { id: true, groupId: true, attendanceEnabled: true, price: true },
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

    const entries = await Promise.all(
      dto.entries.map(async (e) => {
        const meal = mealMap.get(e.mealId)!;
        const price = await this.resolveEffectiveMealPrice(
          meal.id,
          meal.groupId,
          organizationId,
          e.attendanceDate,
          (meal as any).price ?? null,
        );
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
          price,
        };
      }),
    );

    // SRS FR-DISP-010: bulk self-marks respect the period lock too — one
    // check per distinct (group, date) pair, not per row.
    const lockPairs = new Map<string, { groupId: string; dateStr: string }>();
    for (const e of dto.entries) {
      const groupId = mealMap.get(e.mealId)!.groupId;
      lockPairs.set(`${groupId}:${e.attendanceDate}`, {
        groupId,
        dateStr: e.attendanceDate,
      });
    }
    for (const { groupId, dateStr } of lockPairs.values()) {
      await this.assertPeriodNotFinalized(organizationId, groupId, dateStr);
    }

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
    // 1. Verify meal exists in org (+ pricing flag for the FR-OVR-001 gate)
    const meal = await this.prisma.meal.findFirst({
      where: { id: dto.mealId, organizationId },
      select: {
        id: true,
        groupId: true,
        price: true,
        group: { select: { mealPricingEnabled: true } },
        organization: { select: { timezone: true } },
      },
    });
    if (!meal) throw new NotFoundException('Meal not found');

    // SRS FR-TIME-006 (LOOP-024): bounded admin backfill — an override may not
    // reach further back than adminBackfillDays, and never into the future.
    const backfillDays = this.config.get<number>(
      'attendance.adminBackfillDays',
      30,
    );
    const orgTzForBound =
      (meal as any).organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = getTodayInTimezone(orgTzForBound);
    const dateStr = dto.attendanceDate;
    if (dateStr > todayStr) {
      throw new UnprocessableEntityException({
        message: 'Attendance cannot be overridden for future dates',
        errors: { attendanceDate: 'Must be today or a past date' },
      });
    }
    const backfillAgeMs =
      toUtcMidnight(todayStr).getTime() - toUtcMidnight(dateStr).getTime();
    if (backfillAgeMs > backfillDays * 24 * 60 * 60 * 1000) {
      throw new UnprocessableEntityException({
        message: `Overrides are limited to the last ${backfillDays} days`,
        code: 'BACKFILL_LIMIT',
        errors: { attendanceDate: `Older than ${backfillDays} days` },
      });
    }

    // SRS FR-DISP-010: no writes into a finalized billing period.
    await this.assertPeriodNotFinalized(
      organizationId,
      meal.groupId,
      dto.attendanceDate,
    );

    // 2. Verify target user belongs to org
    const targetUser = await this.prisma.user.findFirst({
      where: { id: dto.userId, organizationId },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundException('User not found in organization');

    // 3. Admin override bypasses window validation and vacation mode
    const attendanceDateUtc = toUtcMidnight(dto.attendanceDate);
    const overridePrice = await this.resolveEffectiveMealPrice(
      meal.id,
      meal.groupId,
      organizationId,
      dto.attendanceDate,
      (meal as any).price ?? null,
    );

    // FR-OVR-001 / FR-FAIR-010 (Module 33): the Δliability classifier.
    // billable(present) = effectivePrice; billable(anything else / none) = 0.
    // A liability-INCREASING override (none/absent/skip/vacation → present on
    // a priced meal) is never applied unilaterally — it becomes a pending
    // member confirmation (FR-OVR-020) and the record changes only after the
    // member consents. Neutral/decrease overrides apply exactly as before,
    // so Attendance-Only and unpriced groups are completely unaffected.
    const pricingActive =
      (meal as any).group?.mealPricingEnabled === true &&
      (overridePrice ?? 0) > 0;
    if (pricingActive && dto.status === 'present') {
      const existing = await this.attendanceRepo.findByKey(
        dto.userId,
        dto.mealId,
        attendanceDateUtc,
        organizationId,
      );
      if (existing?.status !== 'present') {
        const confirmation = await this.createMemberConfirmation({
          adminId,
          organizationId,
          groupId: meal.groupId,
          userId: dto.userId,
          mealId: dto.mealId,
          attendanceDate: attendanceDateUtc,
          requestedStatus: dto.status,
          requestedPreference: dto.preference ?? null,
          note: dto.note ?? null,
          requestId,
        });
        return {
          requiresMemberConsent: true,
          message:
            'This change would increase the member’s bill, so it needs their consent. ' +
            'A confirmation request has been sent to the member; the record updates only after they confirm.',
          correctionRequest: confirmation,
        };
      }
    }

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
      price: overridePrice,
      source: 'admin', // Module 33 consent trail (neutral/decrease change)
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

    // Module 22 (FR-HG-035/054): override away from Present cascades to the
    // host's booked guests per policy (audited inside the guests service).
    this.reconcileGuests({
      organizationId,
      groupId: meal.groupId,
      hostUserId: dto.userId,
      mealId: dto.mealId,
      attendanceDate: attendanceDateUtc,
      newStatus: dto.status,
      actorId: adminId,
      requestId,
    });

    // 6. Audit — LOOP-031: an admin acting on their OWN record is flagged.
    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: record.id,
      targetType: 'Attendance',
      action: AuditAction.update,
      metadata: {
        override: true,
        targetUserId: dto.userId,
        status: dto.status,
        ...(dto.note ? { reason: dto.note } : {}),
        ...(dto.userId === adminId ? { selfAction: true } : {}),
      },
      requestId,
    });

    // 7. SRS FR-TRUST-011: the member hears about every non-self change to
    // their record — push with the delta (fire-and-forget, never blocks).
    if (dto.userId !== adminId) {
      void this.notifications?.notifyAttendanceChanged({
        organizationId,
        userId: dto.userId,
        newStatus: dto.status,
        dateStr: dto.attendanceDate,
        reason: dto.note ?? null,
        changedBy: 'admin',
      });
    }

    return AttendanceSerializer.toMarkResponse(record);
  }

  // ── Governed admin bulk override (FR-ATT-033 / LOOP-025) ──────────────────

  /**
   * SRS FR-ATT-033: bulk marking applies the FR-ATT-031 consent rule PER ROW —
   * neutral/decrease rows apply immediately; liability-increasing rows are
   * held as pending member confirmations and reported back as
   * `requiresConsent`. Row-capped (LOOP-032 partial control: no unbounded
   * mass changes in one action) and every row outcome is audited via the
   * per-row paths plus one bulk summary entry.
   */
  async adminBulkOverride(
    adminId: string,
    organizationId: string,
    dto: AdminBulkOverrideDto,
    requestId?: string,
  ) {
    const maxRows = this.config.get<number>(
      'attendance.bulkOverrideMaxRows',
      100,
    );
    if (dto.rows.length > maxRows) {
      throw new UnprocessableEntityException({
        message: `Bulk override is limited to ${maxRows} rows per request`,
        code: 'BULK_ROW_LIMIT',
        errors: { rows: `Received ${dto.rows.length}, max ${maxRows}` },
      });
    }

    const results: Array<Record<string, unknown>> = [];
    let applied = 0;
    let requiresConsent = 0;
    let failed = 0;

    // Sequential on purpose: each row reuses the full single-override path
    // (classifier, period lock, backfill bound, cache, realtime, audit,
    // member notify). Bulk is a rare admin action — correctness over speed.
    for (const row of dto.rows) {
      try {
        const outcome: any = await this.adminOverride(
          adminId,
          organizationId,
          { ...row, note: row.note ?? dto.reason ?? undefined },
          requestId,
        );
        if (outcome?.requiresMemberConsent) {
          requiresConsent += 1;
          results.push({
            userId: row.userId,
            mealId: row.mealId,
            attendanceDate: row.attendanceDate,
            outcome: 'requiresConsent',
            correctionRequestId: outcome.correctionRequest?.id ?? null,
          });
        } else {
          applied += 1;
          results.push({
            userId: row.userId,
            mealId: row.mealId,
            attendanceDate: row.attendanceDate,
            outcome: 'applied',
            recordId: outcome?.id ?? null,
          });
        }
      } catch (err) {
        failed += 1;
        const resp =
          err instanceof HttpException ? (err.getResponse() as any) : null;
        results.push({
          userId: row.userId,
          mealId: row.mealId,
          attendanceDate: row.attendanceDate,
          outcome: 'error',
          message:
            (typeof resp === 'object' ? resp?.message : resp) ??
            (err as Error).message,
          ...(typeof resp === 'object' && resp?.code
            ? { code: resp.code }
            : {}),
        });
      }
    }

    // One bulk summary audit row (per-row outcomes already audited above).
    this.audit.log({
      organizationId,
      actorId: adminId,
      targetType: 'Attendance',
      action: AuditAction.update,
      metadata: {
        bulkOverride: true,
        rows: dto.rows.length,
        applied,
        requiresConsent,
        failed,
        ...(dto.reason ? { reason: dto.reason } : {}),
      },
      requestId,
    });

    return { total: dto.rows.length, applied, requiresConsent, failed, results };
  }

  // ── Record change history (FR-TRUST-010) ──────────────────────────────────

  /**
   * SRS FR-TRUST-010: a member sees, per attendance record, WHO set/changed it
   * (self / admin name / system default / verified), when, through what source
   * artifact, and why — no change to billable data is hidden. Members may only
   * view their own records; admins any record in the org.
   */
  async getRecordHistory(
    requesterId: string,
    requesterRole: string,
    organizationId: string,
    recordId: string,
  ) {
    const record = await this.prisma.attendanceRecord.findFirst({
      where: { id: recordId, organizationId },
      select: {
        id: true,
        userId: true,
        groupId: true,
        mealId: true,
        attendanceDate: true,
        status: true,
        source: true,
        sourceRequestId: true,
        markedBy: true,
        markedAt: true,
        price: true,
      },
    });
    if (!record) throw new NotFoundException('Attendance record not found');

    const isAdmin = ADMIN_ROLES.includes(requesterRole);
    if (!isAdmin && record.userId !== requesterId) {
      throw new ForbiddenException('You can only view your own record history');
    }

    const logs = await this.prisma.auditLog.findMany({
      where: { organizationId, targetType: 'Attendance', targetId: recordId },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        actorId: true,
        action: true,
        metadata: true,
        createdAt: true,
      },
    });

    // Resolve actor display names in one query.
    const actorIds = [
      ...new Set(logs.map((l) => l.actorId).filter(Boolean) as string[]),
    ];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, role: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    const describeActor = (
      actorId: string | null,
      meta: Record<string, unknown> | null,
    ): { actorName: string; actorKind: string } => {
      const source = (meta?.source as string) ?? null;
      if (source === 'system_default' || actorId === null) {
        return { actorName: 'Group policy (auto)', actorKind: 'system' };
      }
      if (source === 'verified') {
        return { actorName: 'Verified scan', actorKind: 'verified' };
      }
      if (actorId === record.userId) {
        return { actorName: 'You', actorKind: 'self' };
      }
      const actor = actorMap.get(actorId);
      return {
        actorName: actor?.name ?? 'An administrator',
        actorKind: 'admin',
      };
    };

    return {
      record: {
        id: record.id,
        userId: record.userId,
        mealId: record.mealId,
        attendanceDate: record.attendanceDate.toISOString().slice(0, 10),
        status: record.status,
        source: record.source ?? 'self',
        sourceRequestId: record.sourceRequestId ?? null,
        markedBy: record.markedBy ?? null,
        markedAt: record.markedAt?.toISOString() ?? null,
        price: record.price ?? null,
      },
      history: logs.map((l) => {
        const meta = (l.metadata ?? {}) as Record<string, unknown>;
        const { actorName, actorKind } = describeActor(l.actorId, meta);
        return {
          at: l.createdAt.toISOString(),
          action: l.action,
          actorName,
          actorKind,
          status: (meta.status as string) ?? null,
          source: (meta.source as string) ?? null,
          reason: (meta.reason as string) ?? null,
          sourceRequestId: (meta.sourceRequestId as string) ?? null,
        };
      }),
    };
  }

  // ── Module 33: member confirmation + consented-change write path ──────────

  /**
   * FR-OVR-020: create (or idempotently reuse) a pending member confirmation
   * when an admin proposes a liability-increasing change. Stored as an
   * AttendanceCorrectionRequest with sourceChannel='admin_prompt'; the
   * proposing admin is kept in reviewedBy and the member decides via
   * confirm/decline (corrections module).
   */
  private async createMemberConfirmation(params: {
    adminId: string;
    organizationId: string;
    groupId: string;
    userId: string;
    mealId: string;
    attendanceDate: Date;
    requestedStatus: string;
    requestedPreference: string | null;
    note: string | null;
    requestId?: string;
  }): Promise<Record<string, unknown>> {
    const toPayload = (r: any) => ({
      id: r.id,
      status: r.status,
      requestType: r.requestType,
      sourceChannel: r.sourceChannel,
      userId: r.userId,
      mealId: r.mealId,
      attendanceDate: r.attendanceDate.toISOString().slice(0, 10),
      expiresAt: r.expiresAt.toISOString(),
    });

    // Idempotent: one open confirmation per (member, meal, date).
    const existing = await this.prisma.attendanceCorrectionRequest.findFirst({
      where: {
        organizationId: params.organizationId,
        userId: params.userId,
        mealId: params.mealId,
        attendanceDate: params.attendanceDate,
        status: 'pending',
        sourceChannel: 'admin_prompt',
      },
    });
    if (existing) return toPayload(existing);

    const expiryHours =
      this.config.get<number>('corrections.expiryHours') ?? 48;
    const created = await this.prisma.attendanceCorrectionRequest.create({
      data: {
        organizationId: params.organizationId,
        groupId: params.groupId,
        userId: params.userId,
        mealId: params.mealId,
        attendanceDate: params.attendanceDate,
        requestType: 'claim_present',
        requestedStatus: params.requestedStatus,
        requestedPreference: params.requestedPreference,
        reason: params.note,
        status: 'pending',
        sourceChannel: 'admin_prompt',
        reviewedBy: params.adminId, // proposing admin (consent artifact trail)
        expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
      },
    });

    this.audit.log({
      organizationId: params.organizationId,
      actorId: params.adminId,
      targetId: created.id,
      targetType: 'AttendanceCorrectionRequest',
      action: AuditAction.create,
      metadata: {
        sourceChannel: 'admin_prompt',
        targetUserId: params.userId,
        mealId: params.mealId,
      },
      requestId: params.requestId,
    });

    // Notify the member (their prompt) + the group (admin queue refresh).
    this.gateway?.emitToUser(
      params.userId,
      'correction.requested.v1',
      toPayload(created),
    );
    this.gateway?.emitToGroup(
      params.groupId,
      'correction.requested.v1',
      toPayload(created),
    );

    return toPayload(created);
  }

  /**
   * Module 33: shared write path for member-consented attendance changes
   * (approved ACR, member confirmation, auto-approved decrease). One place
   * for price snapshot, idempotent upsert, cache invalidation, realtime and
   * audit — used by the corrections module so its writes behave EXACTLY like
   * every other attendance write.
   */
  async applyConsentedChange(params: {
    actorId: string;
    organizationId: string;
    userId: string;
    groupId: string;
    mealId: string;
    attendanceDate: string; // YYYY-MM-DD
    status: string;
    preference?: string | null;
    note?: string | null;
    markedBy?: string | null;
    source: string; // request | admin | system_default | verified
    sourceRequestId?: string | null;
    auditMetadata?: Record<string, unknown>;
    requestId?: string;
  }) {
    // SRS FR-DISP-010: consented changes also respect the period lock — a
    // late ACR approval into a locked month requires an audited reopen first.
    await this.assertPeriodNotFinalized(
      params.organizationId,
      params.groupId,
      params.attendanceDate,
    );

    const meal = await this.prisma.meal.findFirst({
      where: { id: params.mealId, organizationId: params.organizationId },
      select: { price: true },
    });
    const price = await this.resolveEffectiveMealPrice(
      params.mealId,
      params.groupId,
      params.organizationId,
      params.attendanceDate,
      meal?.price ?? null,
    );

    const record = await this.attendanceRepo.upsert({
      organizationId: params.organizationId,
      groupId: params.groupId,
      userId: params.userId,
      mealId: params.mealId,
      attendanceDate: toUtcMidnight(params.attendanceDate),
      status: params.status,
      preference: params.preference ?? null,
      note: params.note ?? null,
      markedAt: new Date(),
      markedBy: params.markedBy ?? null,
      price,
      source: params.source,
      sourceRequestId: params.sourceRequestId ?? null,
    });

    await this.invalidateAttendanceCache(
      params.organizationId,
      params.userId,
      params.groupId,
      params.attendanceDate,
      params.mealId,
    );

    this.emitAttendanceUpdated(params.groupId, record, params.organizationId);

    // Module 22 (FR-HG-035): consented corrections away from Present cancel
    // the host's booked guests too (e.g. approved correct_to_absent).
    this.reconcileGuests({
      organizationId: params.organizationId,
      groupId: params.groupId,
      hostUserId: params.userId,
      mealId: params.mealId,
      attendanceDate: toUtcMidnight(params.attendanceDate),
      newStatus: params.status,
      actorId: params.actorId,
      requestId: params.requestId,
    });

    this.audit.log({
      organizationId: params.organizationId,
      actorId: params.actorId,
      targetId: record.id,
      targetType: 'Attendance',
      action: AuditAction.update,
      metadata: {
        source: params.source,
        sourceRequestId: params.sourceRequestId ?? null,
        ...(params.auditMetadata ?? {}),
      },
      requestId: params.requestId,
    });

    return record;
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

    // Additive: excused vacation days in [from,to] from approved vacation
    // requests, counted SEPARATELY (never in the present/absent/skipped
    // denominator). Lets the dashboard show a "Vacation: N" stat without
    // recording per-day onVacation rows. New field — additive, contract-safe.
    const approvedVacations = await this.prisma.vacationRequest.findMany({
      where: {
        userId,
        status: 'approved',
        startDate: { lte: toDate },
        endDate: { gte: fromDate },
      },
      select: { startDate: true, endDate: true },
    });
    let vacationDays = 0;
    for (const v of approvedVacations) {
      const s = v.startDate.getTime() > fromDate.getTime() ? v.startDate : fromDate;
      const e = v.endDate.getTime() < toDate.getTime() ? v.endDate : toDate;
      const days = Math.floor((e.getTime() - s.getTime()) / 86400000) + 1;
      if (days > 0) vacationDays += days;
    }
    (response as Record<string, unknown>).vacationDays = vacationDays;

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
      snapshotPrice: counts.snapshotPrice,
      preferenceBreakdown: counts.preferenceBreakdown,
    });

    // Module 22 (FR-HG-060/061): kitchen counts include booked+approved
    // guests as EXTRA plates — member vs guest never conflated. Additive keys.
    const guestCounts = this.guests
      ? await this.guests.getMealGuestCounts(
          organizationId,
          query.mealId,
          attendanceDateUtc,
        )
      : { guestCount: 0, guestAdults: 0, guestChildren: 0, guestPreferenceBreakdown: {} };

    const response = {
      ...MealAttendanceSummarySerializer.toResponse(summaryEntity),
      ...guestCounts,
      attendingTotal: counts.presentCount + guestCounts.guestCount,
    };

    // Cache result
    await this.redis.set(cacheKey, JSON.stringify(response), CACHE_TTL);

    return response;
  }

  // ── Billing summary (Member Billing V2, admin) ────────────────────────────

  /**
   * Group-wide billing aggregation for the Member Billing V2 dashboard.
   * Returns accurate (uncapped) revenue / member / meal figures computed from
   * the per-record price SNAPSHOT (present-only revenue). Day-wise override
   * prices already live in the snapshot, so this needs no special handling.
   */
  async getBillingSummary(organizationId: string, query: QueryBillingDto) {
    if (!query.groupId) {
      throw new BadRequestException({
        message: 'groupId is required',
        errors: { groupId: 'Provide a groupId query parameter' },
      });
    }

    // Pass 12: group policy in ONE query up front (guest policy + billing
    // cycle + org timezone) — replaces the former mid-function lookup, so
    // the hot path gains no extra query.
    const groupPolicy = await this.prisma.group.findFirst({
      where: { id: query.groupId, organizationId },
      select: {
        billNoShowGuests: true,
        guestAttendanceEnabled: true,
        billingCycleStartDay: true,
        organization: { select: { timezone: true } },
      },
    });

    // FR-BILLX-020/041: no explicit range → the group's CURRENT billing
    // period in ORG TIME (cycle start day, or calendar month), replacing the
    // arbitrary "last 30 days" default. Explicit ranges behave as before.
    let fromStr = query.fromDate;
    let toStr = query.toDate;
    let periodSource: 'explicit' | 'cycle' = 'explicit';
    if (!fromStr && !toStr) {
      const tz = groupPolicy?.organization?.timezone ?? 'Asia/Kolkata';
      const period = this.billing?.resolveCurrentPeriod?.(
        getTodayInTimezone(tz),
        (groupPolicy as any)?.billingCycleStartDay ?? null,
      );
      if (period) {
        fromStr = period.fromDate;
        toStr = period.toDate;
        periodSource = 'cycle';
      }
    }
    const toDate = toStr ? toUtcMidnight(toStr) : new Date();
    const fromDate = fromStr
      ? toUtcMidnight(fromStr)
      : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // FR-BILLX-050: version-keyed read cache. Every billing-relevant write
    // bumps the group version, orphaning all cached ranges instantly; the
    // TTL (env BILLING_SUMMARY_CACHE_TTL_SECONDS, 0 = disabled) only bounds
    // Redis memory for orphaned keys.
    const summaryTtl = this.config.get<number>(
      'attendance.billingSummaryCacheTtlSeconds',
      60,
    );
    const ver = (await this.billing?.getBillingVersion?.(query.groupId)) ?? '0';
    const cacheKey = `bill:sum:${organizationId}:${query.groupId}:${ver}:${formatUtcDate(fromDate)}:${formatUtcDate(toDate)}`;
    if (summaryTtl > 0) {
      try {
        const hit = await this.redis.get(cacheKey);
        if (hit) return JSON.parse(hit);
      } catch {
        /* cache is best-effort */
      }
    }

    const { members, records } = await this.attendanceRepo.getBillingData(
      query.groupId,
      organizationId,
      fromDate,
      toDate,
    );

    const byUser = new Map<
      string,
      {
        present: number;
        skipped: number;
        absent: number;
        vacation: number;
        totalBill: number;
        lastActivity: Date | null;
      }
    >();
    const byMeal = new Map<
      string,
      { mealName: string; revenue: number; presentCount: number }
    >();
    // Pass 12 (FR-BILLX-021): per-slot rollup for the summary contract.
    const bySlot = new Map<string, { presentCount: number; revenue: number }>();

    let revenue = 0;
    let presentMeals = 0;
    let skippedMeals = 0;
    let absentMeals = 0;
    // FR-BILLX-012/021: vacation days reported separately from absences.
    let vacationDays = 0;

    for (const r of records) {
      const u =
        byUser.get(r.userId) ??
        { present: 0, skipped: 0, absent: 0, vacation: 0, totalBill: 0, lastActivity: null };

      if (r.status === 'present') {
        const p = r.price ?? 0;
        u.present += 1;
        u.totalBill += p;
        presentMeals += 1;
        revenue += p;
        const mb =
          byMeal.get(r.mealId) ??
          { mealName: r.mealName, revenue: 0, presentCount: 0 };
        mb.revenue += p;
        mb.presentCount += 1;
        mb.mealName = r.mealName;
        byMeal.set(r.mealId, mb);
        const slotKey = (r as any).slotKey ?? 'general';
        const sb = bySlot.get(slotKey) ?? { presentCount: 0, revenue: 0 };
        sb.presentCount += 1;
        sb.revenue += p;
        bySlot.set(slotKey, sb);
      } else if (r.status === 'skipped') {
        u.skipped += 1;
        skippedMeals += 1;
      } else if (r.status === 'absent') {
        u.absent += 1;
        absentMeals += 1;
      } else if (r.status === 'onVacation') {
        u.vacation += 1;
        vacationDays += 1;
      }

      if (r.markedAt && (!u.lastActivity || r.markedAt > u.lastActivity)) {
        u.lastActivity = r.markedAt;
      }
      byUser.set(r.userId, u);
    }

    // Module 22 (FR-HG-050/053): each host's bill = own meals + Σ guest
    // priceSnapshot (booked/approved; no-shows per billNoShowGuests). One
    // groupBy query — separated from member charges, never conflated.
    let guestByHost = new Map<string, { guestCount: number; guestAmount: number }>();
    let guestRevenue = 0;
    if (this.guests && groupPolicy?.guestAttendanceEnabled) {
      guestByHost = await this.guests.getGuestBillingByHost(
        organizationId,
        query.groupId,
        fromDate,
        toDate,
        groupPolicy.billNoShowGuests ?? true,
      );
      for (const g of guestByHost.values()) guestRevenue += g.guestAmount;
    }

    // Pass 12 (FR-BILLX-030/043): signed append-only ledger adjustments —
    // balance = Σ(price snapshots) + Σ(guest snapshots) + Σ(adjustments).
    const adjustmentsByUser =
      (await this.billing?.sumAdjustmentsByUser?.(
        organizationId,
        query.groupId,
        fromDate,
        toDate,
      )) ?? new Map<string, number>();
    let adjustmentsTotal = 0;
    for (const v of adjustmentsByUser.values()) adjustmentsTotal += v;

    const memberMeta = new Map(members.map((m) => [m.userId, m]));
    const allUserIds = new Set<string>([
      ...members.map((m) => m.userId),
      ...byUser.keys(),
      ...guestByHost.keys(),
      ...adjustmentsByUser.keys(),
    ]);

    const memberList = [...allUserIds]
      .map((uid) => {
        const agg =
          byUser.get(uid) ??
          { present: 0, skipped: 0, absent: 0, vacation: 0, totalBill: 0, lastActivity: null };
        const meta = memberMeta.get(uid);
        const guest = guestByHost.get(uid) ?? { guestCount: 0, guestAmount: 0 };
        const adjustments = adjustmentsByUser.get(uid) ?? 0;
        return {
          userId: uid,
          userName: meta?.name ?? uid,
          role: meta?.role ?? 'member',
          email: meta?.email ?? null,
          phone: meta?.phone ?? null,
          totalBill: agg.totalBill + guest.guestAmount,
          presentCount: agg.present,
          skippedCount: agg.skipped,
          absentCount: agg.absent,
          // FR-BILLX-012: vacation reported separately from absences.
          vacationDays: agg.vacation,
          // FR-HG-053: guest charges itemised separately from member charges.
          guestCount: guest.guestCount,
          guestAmount: guest.guestAmount,
          // FR-BILLX-030/031: signed ledger total + the resulting net bill.
          adjustmentsTotal: adjustments,
          netBill: agg.totalBill + guest.guestAmount + adjustments,
          lastActivity: agg.lastActivity ? agg.lastActivity.toISOString() : null,
        };
      })
      .sort((a, b) => b.totalBill - a.totalBill);

    revenue += guestRevenue;
    const memberCount = members.length;
    const averageBill = memberCount > 0 ? Math.round(revenue / memberCount) : 0;

    const mealBreakdown = [...byMeal.entries()]
      .map(([mealId, v]) => ({
        mealId,
        mealName: v.mealName,
        revenue: v.revenue,
        presentCount: v.presentCount,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Pass 12 (FR-BILLX-021): per-slot rollup, revenue-descending.
    const slotBreakdown = [...bySlot.entries()]
      .map(([slotKey, v]) => ({
        slotKey,
        presentCount: v.presentCount,
        revenue: v.revenue,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const response = {
      // FR-BILLX-020: which period this summary covers and why.
      period: {
        fromDate: formatUtcDate(fromDate),
        toDate: formatUtcDate(toDate),
        cycleStartDay: (groupPolicy as any)?.billingCycleStartDay ?? null,
        source: periodSource,
      },
      summary: {
        revenue,
        memberCount,
        presentMeals,
        skippedMeals,
        absentMeals,
        averageBill,
        // Module 22 (FR-HG-053): guest component surfaced separately.
        guestRevenue,
        // Pass 12: ledger + vacation transparency (FR-BILLX-030/012).
        adjustmentsTotal,
        netRevenue: revenue + adjustmentsTotal,
        vacationDays,
      },
      mealBreakdown,
      slotBreakdown,
      members: memberList,
    };

    // FR-BILLX-050: cache under the current billing version (configurable TTL).
    if (summaryTtl > 0) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(response), summaryTtl);
      } catch {
        /* cache is best-effort */
      }
    }

    return response;
  }

  // ── Billing series (analytics charts, admin) ──────────────────────────────

  /**
   * Bucketed billing time-series for the Member Billing analytics charts:
   * revenue + present-meal counts per day / week / month. Reuses
   * getBillingData (present-only, price snapshot). Additive — no contract change.
   */
  async getBillingSeries(organizationId: string, query: QueryBillingSeriesDto) {
    if (!query.groupId) {
      throw new BadRequestException({
        message: 'groupId is required',
        errors: { groupId: 'Provide a groupId query parameter' },
      });
    }
    const bucket = query.bucket ?? 'day';
    const toDate = query.toDate ? toUtcMidnight(query.toDate) : new Date();
    const fromDate = query.fromDate
      ? toUtcMidnight(query.fromDate)
      : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const { records } = await this.attendanceRepo.getBillingData(
      query.groupId,
      organizationId,
      fromDate,
      toDate,
    );

    const pad = (n: number) => String(n).padStart(2, '0');
    const keyOf = (d: Date): string => {
      const y = d.getUTCFullYear();
      const m = pad(d.getUTCMonth() + 1);
      const day = pad(d.getUTCDate());
      if (bucket === 'month') return `${y}-${m}`;
      if (bucket === 'week') {
        const dow = (d.getUTCDay() + 6) % 7; // 0=Mon
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - dow);
        return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
      }
      return `${y}-${m}-${day}`;
    };

    const byKey = new Map<string, { revenue: number; presentMeals: number }>();
    for (const r of records) {
      if (r.status !== 'present') continue;
      const k = keyOf(r.attendanceDate);
      const agg = byKey.get(k) ?? { revenue: 0, presentMeals: 0 };
      agg.revenue += r.price ?? 0;
      agg.presentMeals += 1;
      byKey.set(k, agg);
    }

    const series = [...byKey.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, v]) => ({
        label,
        revenue: v.revenue,
        presentMeals: v.presentMeals,
      }));

    return { bucket, series };
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
      // Issue 4: bust the cached dashboards so admin present/absent counts and
      // the student dashboard reflect this mark immediately (the documented
      // "invalidated on attendance change" behaviour was not wired before).
      `dashboard:admin:${organizationId}`,
      `dashboard:student:${organizationId}:${userId}`,
    ];

    if (mealId) {
      keysToDelete.push(mealSummaryKey(organizationId, mealId, date));
    }

    await this.redis.del(...keysToDelete);

    // Pass 12 (FR-BILLX-050): any attendance change invalidates the billing
    // read-cache in O(1) via the group's version key (fire-and-forget).
    void this.billing?.bumpBillingVersion?.(groupId);
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
