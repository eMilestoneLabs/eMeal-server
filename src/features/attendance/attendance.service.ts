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
import { getVacationCoveredUserIds } from '../../common/utils/vacation-coverage.util';
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

  // command_6 (timezone integrity): in-process org-timezone TTL cache — same
  // pattern as GroupsRepository.getOrganizationTimezone, so "org today"
  // lookups never pay a per-request PK query on hot read paths.
  private readonly orgTzCache = new Map<string, { tz: string; exp: number }>();

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
   * command_6 (timezone integrity): the organization's CURRENT calendar date
   * (YYYY-MM-DD). "Today" defaults must anchor on the ORG's day — the
   * server's UTC date is still YESTERDAY between local midnight and the tz
   * offset (00:00–05:30 for IST), which served the wrong day to
   * early-morning users. Timezone comes from the org row (5-min in-process
   * cache), so any international org gets its own correct day.
   */
  async getOrgToday(organizationId: string): Promise<string> {
    // Live-Test-7 P0: accounts that never joined a group carry no
    // organizationId (nullable column → absent from the JWT). A null id in
    // findUnique throws a PrismaClientValidationError → 500 on every read
    // that resolves "today". Fall back to the same default timezone the org
    // lookup below uses.
    if (!organizationId) return getTodayInTimezone('Asia/Kolkata');
    const ttlMs = parseInt(process.env.ORG_TZ_CACHE_TTL_MS ?? '300000', 10);
    const hit = this.orgTzCache.get(organizationId);
    let tz: string;
    if (hit && hit.exp > Date.now()) {
      tz = hit.tz;
    } else {
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      });
      tz = org?.timezone ?? 'Asia/Kolkata';
      this.orgTzCache.set(organizationId, { tz, exp: Date.now() + ttlMs });
    }
    return getTodayInTimezone(tz);
  }

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
    /** Live-Test-6 ISSUE-2: the day's preference override — rides the SAME
     *  entry query (zero extra reads) so Present validation can mirror the
     *  exact group set /meals/today rendered for this day. */
    preferencesEnabled: boolean | null;
    enabledPreferenceGroupIds: string[];
  }> {
    const dateUtc = toUtcMidnight(dateStr);
    const dow = (dateUtc.getUTCDay() + 6) % 7;
    const entrySelect = {
      openTime: true,
      closeTime: true,
      price: true,
      preferencesEnabled: true,
      enabledPreferenceGroupIds: true,
    } as const;
    let entry = await this.prisma.scheduleEntry.findFirst({
      where: {
        mealId,
        date: dateUtc,
        schedule: { groupId, organizationId, isPublished: true },
      },
      select: entrySelect,
    });
    if (!entry) {
      entry = await this.prisma.scheduleEntry.findFirst({
        where: {
          mealId,
          dayOfWeek: dow,
          schedule: { groupId, organizationId, isPublished: true },
        },
        orderBy: { schedule: { weekStart: 'desc' } },
        select: entrySelect,
      });
    }
    return {
      openTime: entry?.openTime ? entry.openTime : master.openTime,
      closeTime: entry?.openTime ? entry.closeTime : master.closeTime,
      price: entry?.price != null ? entry.price : master.price,
      scheduledToday: !!entry,
      preferencesEnabled: entry?.preferencesEnabled ?? null,
      enabledPreferenceGroupIds: entry?.enabledPreferenceGroupIds ?? [],
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

    // SRS Module 03 (survey Q17/Q21): members choose Present or Absent only —
    // Skip is SYSTEM-generated at window close (non-response), never a member
    // input. Old APKs still ship a "Skip meal" button that POSTs
    // status='skipped'; that intent ("I won't eat this meal") is exactly
    // Module-3 Absent, so it is coerced rather than rejected — old devices
    // keep working, no member-generated Skip row is ever stored, and Bill-Skip
    // (which bills NON-RESPONDERS at the snapshot price) can no longer bill a
    // member who explicitly declined. New APKs have no Skip button.
    const status =
      (dto.status ?? 'present') === 'skipped' ? 'absent' : dto.status ?? 'present';

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
      let pgGroups = await this.preferencesService.getEffectiveGroupsForMeal(
        meal.id,
        organizationId,
      );
      // Live-Test-6 ISSUE-2: validate against the DAY-EFFECTIVE group set —
      // the same planner overlay /meals/today rendered (preferences off for
      // the day / day subset). Without this, a day that hides a required
      // master group made Present un-markable for members AND admin self-marks
      // (client sends the day set, server demanded the master set → 422).
      // The override rode the resolveEffectiveWindow query above: zero cost.
      if (plannerActive && effective.scheduledToday) {
        pgGroups = this.preferencesService.applyDayOverride(
          pgGroups,
          effective,
        );
      }
      if (pgGroups.length > 0) {
        const validated = this.preferencesService.validateSelections(
          pgGroups,
          dto.selections ?? [],
        );
        // Option deltas bill only when meal pricing is active (base price set);
        // without a base price, selections are recorded but never billed.
        //
        // UNIT BOUNDARY (Issue 1/2): option priceDelta is stored in paise (the
        // admin editor ×100s the ₹ it's given), but the base meal price and the
        // whole billing engine work in whole ₹. Adding the paise delta straight
        // onto the ₹ base corrupted the price snapshot — a "+₹30" option turned
        // a ₹75 meal into ₹3075. Convert the delta to ₹ here, the single point
        // where it enters the ₹ price. Whole-₹ options (the only kind the editor
        // can produce) divide exactly; the round only guards hand-crafted data.
        if (effectivePrice != null) {
          markPrice = effectivePrice + Math.round(validated.totalDelta / 100);
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

  // ── Admin override — REMOVED (SRS Module 03 ATT-004) ─────────────────────

  /**
   * SRS Module 03 ATT-004: Administrators and Managers shall NEVER mark,
   * modify, or override another member's attendance — attendance ownership
   * belongs to the member alone, and post-window changes flow exclusively
   * through the member-initiated Correction Request workflow (admin only
   * approves or rejects).
   *
   * An admin marking their OWN attendance is member behaviour: it delegates
   * to the normal marking path and follows the exact same window, vacation
   * and preference rules as every other member.
   */
  async adminOverride(
    adminId: string,
    organizationId: string,
    dto: AdminOverrideDto,
    requestId?: string,
  ) {
    if (dto.userId !== adminId) {
      throw new ForbiddenException({
        message:
          'Administrators cannot mark or edit member attendance. The member must submit an Attendance Correction Request, which you can approve or reject.',
        code: 'ADMIN_OVERRIDE_REMOVED',
        errors: {
          userId: 'Attendance ownership belongs to the member (ATT-004)',
        },
      });
    }
    // Self-mark: same rules as any member (window-gated, vacation-guarded).
    // FR-PG parity: preference-group selections travel through to the member
    // path unchanged, so the admin's Present follows the exact same
    // validation/billing rules as every member's.
    return this.markAttendance(
      adminId,
      organizationId,
      {
        mealId: dto.mealId,
        attendanceDate: dto.attendanceDate,
        status: dto.status,
        preference: dto.preference ?? undefined,
        note: dto.note ?? undefined,
        selections: dto.selections ?? undefined,
      } as any,
      requestId,
    );
  }

  // ── Governed admin bulk override — REMOVED (SRS Module 03 ATT-004) ────────

  /**
   * SRS Module 03 ATT-004: bulk admin marking of member attendance has been
   * removed together with the single-record override. Corrections are the
   * only post-window path and are decided one request at a time.
   */
  async adminBulkOverride(
    _adminId: string,
    _organizationId: string,
    _dto: AdminBulkOverrideDto,
    _requestId?: string,
  ): Promise<never> {
    throw new ForbiddenException({
      message:
        'Administrators cannot mark or edit member attendance. Members submit Attendance Correction Requests, which you can approve or reject.',
      code: 'ADMIN_OVERRIDE_REMOVED',
      errors: { rows: 'Attendance ownership belongs to the member (ATT-004)' },
    });
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

  // ── Module 33: consented-change write path ────────────────────────────────
  // SRS Module 03 ATT-004: createMemberConfirmation (FR-OVR-020 admin-proposed
  // increases) was REMOVED with the admin override — corrections are
  // member-initiated only.

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
    /**
     * SRS Module 03 ATT-004/COR-006: member-submitted preference-group
     * selection set (same shape as marking). Validated and priced exactly
     * like markAttendance, then snapshotted onto the record.
     */
    selections?: Array<Record<string, unknown>> | null;
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
      // Live-Test-6 ISSUE-2: planner flags ride the same meal query so the
      // selection validation below can apply the day override (zero cost).
      select: {
        price: true,
        group: {
          select: {
            mealsEnabled: true,
            weeklyMenuEnabled: true,
            dayWiseMealsEnabled: true,
          },
        },
      },
    });
    // Same call resolveEffectiveMealPrice wraps — taking the full effective
    // object also yields the day's preference override for free.
    const effective = await this.resolveEffectiveWindow(
      params.mealId,
      params.groupId,
      params.organizationId,
      params.attendanceDate,
      { openTime: null, closeTime: null, price: meal?.price ?? null },
    );
    const price = effective.price;

    // ATT-004/COR-006: apply the member's selection set on approval — the
    // exact validation + pricing path markAttendance uses (FR-PG-031/040).
    let finalPrice = price;
    let derivedPreference = params.preference ?? null;
    let selectionSnapshot: Array<Record<string, unknown>> | undefined;
    let selectionRows:
      | Parameters<AttendanceRepository['upsert']>[0]['selectionRows']
      | undefined;
    if (params.status === 'present' && params.selections?.length) {
      let pgGroups = await this.preferencesService.getEffectiveGroupsForMeal(
        params.mealId,
        params.organizationId,
      );
      // Live-Test-6 ISSUE-2: correction approvals replay the member's
      // day-filtered selection set — validate it against the same
      // day-effective groups markAttendance now uses (planner days that
      // narrow/disable groups must not 422 the approval).
      const plannerActive =
        meal?.group?.mealsEnabled !== false &&
        (meal?.group?.weeklyMenuEnabled === true ||
          meal?.group?.dayWiseMealsEnabled === true);
      if (plannerActive && effective.scheduledToday) {
        pgGroups = this.preferencesService.applyDayOverride(
          pgGroups,
          effective,
        );
      }
      if (pgGroups.length > 0) {
        const validated = this.preferencesService.validateSelections(
          pgGroups,
          params.selections as any,
        );
        // Same paise→₹ unit boundary as markAttendance (Issue 1/2).
        if (price != null) {
          finalPrice = price + Math.round(validated.totalDelta / 100);
        }
        derivedPreference = params.preference ?? validated.primaryKey;
        selectionSnapshot = validated.snapshot;
        selectionRows = validated.rows;
      }
    }

    const record = await this.attendanceRepo.upsert({
      organizationId: params.organizationId,
      groupId: params.groupId,
      userId: params.userId,
      mealId: params.mealId,
      attendanceDate: toUtcMidnight(params.attendanceDate),
      status: params.status,
      preference: derivedPreference,
      note: params.note ?? null,
      markedAt: new Date(),
      markedBy: params.markedBy ?? null,
      price: finalPrice,
      source: params.source,
      sourceRequestId: params.sourceRequestId ?? null,
      ...(selectionRows !== undefined
        ? { preferences: selectionSnapshot, selectionRows }
        : {}),
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
    // Live-Test-7 P0: org-less accounts (pre-join, or membership purged) must
    // receive the empty pagination contract — organizationId is a non-nullable
    // column, so a null filter makes Prisma throw (500) before any row is read.
    // Mirrors the /meals/today guard.
    if (!organizationId) {
      return { data: [], total: 0, page: query.page ?? 1, limit: query.limit ?? 20 };
    }
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

    // Live-Test-7 P0: no organization context → all counts are zero by
    // definition. Serve the normal contract instead of letting the org-scoped
    // groupBy throw on a null non-nullable filter (500).
    if (!organizationId) {
      const empty = AttendanceSummarySerializer.toResponse(
        new AttendanceSummaryEntity({
          userId,
          groupId: query.groupId,
          organizationId,
          fromDate: fromStr,
          toDate: toStr,
          totalDays: 0,
          presentCount: 0,
          absentCount: 0,
          skippedCount: 0,
          onVacationCount: 0,
        }),
      );
      (empty as Record<string, unknown>).vacationDays = 0;
      return empty;
    }

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

    // command_6 ultra pass: the status counts and the approved-vacation rows
    // are independent reads — ONE parallel wave (was two sequential).
    const [counts, approvedVacations] = await Promise.all([
      this.attendanceRepo.getUserSummary(
        userId,
        query.groupId,
        organizationId,
        fromDate,
        toDate,
      ),
      this.prisma.vacationRequest.findMany({
        where: {
          userId,
          status: 'approved',
          startDate: { lte: toDate },
          endDate: { gte: fromDate },
        },
        select: { startDate: true, endDate: true },
      }),
    ]);

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
    // requests (fetched in the parallel wave above), counted SEPARATELY
    // (never in the present/absent/skipped denominator) — additive field.
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

  // ── Group vacation members for a date (admin) ────────────────────────────
  // Bug fix (command_3 · "Vacation count not updating"): the admin attendance
  // dashboard "Vacation = N" summary must reflect who is on APPROVED vacation
  // for the SELECTED DATE — not the global isVacationMode flag (which only
  // flips when a vacation covers org-today and is otherwise date-agnostic).
  // Reuses the shared Pass 11 slot-aware coverage util at DAY granularity
  // (mealOpenTime null ⇒ any part of the day on vacation counts). Additive,
  // read-only, org-isolated — no existing contract changes.
  async getGroupVacationMembers(
    organizationId: string,
    groupId: string,
    date: string,
  ): Promise<{
    date: string;
    userIds: string[];
    members: Array<{ userId: string; name: string }>;
    count: number;
  }> {
    if (!groupId) throw new BadRequestException('groupId is required');
    // Validate the date param BEFORE any DB work so malformed input (e.g. an
    // injection probe) fails fast with 400 — never reaches Prisma as an Invalid
    // Date (which would surface as a 500). Mirrors AdminOverrideDto's guard.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD format');
    }

    const dateUtc = toUtcMidnight(date);
    if (Number.isNaN(dateUtc.getTime())) {
      throw new BadRequestException('date is not a valid calendar date');
    }

    // Tenant guard + member fetch in parallel (one round-trip saved). Safe:
    // nothing from the member query is used or returned unless the guard
    // resolves this group inside the caller's org.
    const [group, activeMembers] = await Promise.all([
      this.prisma.group.findFirst({
        where: { id: groupId, organizationId },
        select: { id: true },
      }),
      this.prisma.groupMember.findMany({
        where: { groupId, status: 'active' },
        select: {
          userId: true,
          // name rides along so the admin dashboard can LIST members under the
          // "Vacation" filter (not just count them) — no extra query.
          user: { select: { isVacationMode: true, name: true } },
        },
      }),
    ]);
    if (!group) throw new NotFoundException('Group not found');

    const covered = await getVacationCoveredUserIds(this.prisma as any, {
      organizationId,
      groupId,
      dateUtc,
      mealOpenTime: null, // day-level: whole-day coverage
      candidates: activeMembers.map((m) => ({
        userId: m.userId,
        isVacationMode: m.user.isVacationMode === true,
      })),
    });

    const members = activeMembers
      .filter((m) => covered.has(m.userId))
      .map((m) => ({ userId: m.userId, name: m.user.name ?? 'Member' }));
    return {
      date,
      userIds: members.map((m) => m.userId),
      members,
      count: members.length,
    };
  }

  // ── Meal attendance summary (admin) ──────────────────────────────────────

  async getMealSummary(
    organizationId: string,
    query: QueryMealSummaryDto,
  ) {
    const meal = await this.prisma.meal.findFirst({
      where: { id: query.mealId, organizationId },
      select: {
        id: true,
        slotKey: true,
        name: true,
        displayName: true,
        groupId: true,
        attendanceWindowOpen: true,
      },
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

    // Active members for this group. Same single query as the old count();
    // the vacation flag rides along for FR-ANL-003 below.
    const activeMembers = await this.prisma.groupMember.findMany({
      where: { groupId: meal.groupId, status: 'active' },
      select: { userId: true, user: { select: { isVacationMode: true } } },
    });
    const totalMembers = activeMembers.length;

    // Pass 15 (FR-ANL-003): expected participants = active, non-blocked
    // (status filter above), non-vacation members for THIS meal/date —
    // slot-aware dated vacations via the shared Pass 11 coverage util.
    const onVacation = await getVacationCoveredUserIds(this.prisma as any, {
      organizationId,
      groupId: meal.groupId,
      dateUtc: attendanceDateUtc,
      mealOpenTime: meal.attendanceWindowOpen ?? null,
      candidates: activeMembers.map((m) => ({
        userId: m.userId,
        isVacationMode: m.user.isVacationMode === true,
      })),
    });
    const expectedParticipants = totalMembers - onVacation.size;

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
      preferenceGroupBreakdown: counts.preferenceGroupBreakdown,
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
      // Pass 15 (FR-ANL-003): expected = active − vacationing (never counts
      // blocked/removed members — the membership status filter handles those).
      expectedParticipants,
      // Pass 15 (FR-ANL-022): freshness stamp — cache HITs keep the original.
      generatedAt: new Date().toISOString(),
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
        // SRS Module 03 (survey Q17/Q22): Bill-Skip policy.
        billSkippedMeals: true,
        // Live-Test-7 ISSUE-4: independent Bill-Absent policy (NULL = legacy
        // coupling — Absent follows Bill-Skip, the exact pre-split rule).
        billAbsentMeals: true,
        organization: { select: { timezone: true } },
      },
    });

    // Unknown or foreign-org groupId → explicit 404 instead of a 200-empty
    // summary (org isolation already held; this surfaces typos/stale IDs).
    if (!groupPolicy) {
      throw new NotFoundException('Group not found');
    }

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

    // command_6 ultra pass: the four independent aggregate reads (attendance
    // billing rows, guest charges, ledger adjustments, opening balances) run
    // in ONE parallel wave — they only depend on the policy/dates resolved
    // above, never on each other. Values and policy gating are unchanged.
    const [{ members, records }, guestByHost, adjustmentsDetail, opening] =
      await Promise.all([
        this.attendanceRepo.getBillingData(
          query.groupId,
          organizationId,
          fromDate,
          toDate,
        ),
        this.guests && groupPolicy?.guestAttendanceEnabled
          ? this.guests.getGuestBillingByHost(
              organizationId,
              query.groupId,
              fromDate,
              toDate,
              groupPolicy.billNoShowGuests ?? true,
            )
          : Promise.resolve(
              new Map<string, { guestCount: number; guestAmount: number }>(),
            ),
        // Live-Test-5 ISSUE-4: per-TYPE ledger rollup — same rows, same net
        // (total keeps the exact single-round netting), plus the Debits /
        // Credits / Refunds display components. Optional-chained fallback
        // keeps partial test stubs of the billing service working.
        this.billing?.sumAdjustmentsByUserDetailed?.(
          organizationId,
          query.groupId,
          fromDate,
          toDate,
        ) ??
          Promise.resolve(
            new Map<
              string,
              { total: number; credits: number; debits: number; refunds: number }
            >(),
          ),
        this.billing?.computeOpeningBalances?.(
          organizationId,
          query.groupId,
          fromDate,
          {
            billSkippedMeals: (groupPolicy as any)?.billSkippedMeals === true,
            billAbsentMeals: (groupPolicy as any)?.billAbsentMeals ?? null,
            guestAttendanceEnabled:
              groupPolicy?.guestAttendanceEnabled === true,
            billNoShowGuests: groupPolicy?.billNoShowGuests !== false,
          },
        ) ??
          Promise.resolve({
            byUser: new Map<string, number>(),
            carriedThrough: null as string | null,
          }),
      ]);

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
        // SRS Module 03 (survey Q17/Q22/Q23): Bill Skip = ON bills the
        // system-generated Skip at its snapshotted scheduled price (base +
        // day override — no add-ons, none were selected). Kitchen counts
        // (byMeal/bySlot presentCount) are Present-only and stay untouched.
        if ((groupPolicy as any).billSkippedMeals === true) {
          const p = r.price ?? 0;
          u.totalBill += p;
          revenue += p;
        }
      } else if (r.status === 'absent') {
        u.absent += 1;
        absentMeals += 1;
        // Live-Test-7 ISSUE-4: Absent billing follows its OWN toggle when the
        // admin has set one; NULL keeps the legacy coupling to Bill-Skip
        // ("the Absent button must not recreate the do-nothing loophole").
        if (
          ((groupPolicy as any).billAbsentMeals ??
            (groupPolicy as any).billSkippedMeals) === true
        ) {
          const p = r.price ?? 0;
          u.totalBill += p;
          revenue += p;
        }
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
    // priceSnapshot (booked/approved; no-shows per billNoShowGuests) —
    // fetched in the parallel wave above, summed here.
    let guestRevenue = 0;
    for (const g of guestByHost.values()) guestRevenue += g.guestAmount;

    // Pass 12 (FR-BILLX-030/043): signed append-only ledger adjustments —
    // balance = Σ(price snapshots) + Σ(guest snapshots) + Σ(adjustments).
    // Live-Test-5 ISSUE-4: adjustmentsByUser keeps the legacy net-total map
    // (identical values/rounding as before); the per-type components ride
    // alongside for the itemised Debits/Credits/Refunds display lines.
    const adjustmentsByUser = new Map<string, number>();
    for (const [uid, d] of adjustmentsDetail) adjustmentsByUser.set(uid, d.total);
    let adjustmentsTotal = 0;
    let debitsTotal = 0;
    let creditsTotal = 0;
    let refundsTotal = 0;
    for (const d of adjustmentsDetail.values()) {
      adjustmentsTotal += d.total;
      debitsTotal += d.debits;
      creditsTotal += d.credits;
      refundsTotal += d.refunds;
    }

    // CREDIT-001 (survey 2026-07-13): carried-forward OPENING BALANCES — the
    // closing position of everything through the last FINALIZED period before
    // this range (payable-positive; credit negative). Included in every
    // netBill automatically and itemised via the additive openingBalance
    // field, so all screens/exports reconcile on the same number.
    const openingByUser = opening.byUser;
    let openingBalanceTotal = 0;
    for (const v of openingByUser.values()) openingBalanceTotal += v;

    const memberMeta = new Map(members.map((m) => [m.userId, m]));
    const allUserIds = new Set<string>([
      ...members.map((m) => m.userId),
      ...byUser.keys(),
      ...guestByHost.keys(),
      ...adjustmentsByUser.keys(),
      ...openingByUser.keys(),
    ]);

    const memberList = [...allUserIds]
      .map((uid) => {
        const agg =
          byUser.get(uid) ??
          { present: 0, skipped: 0, absent: 0, vacation: 0, totalBill: 0, lastActivity: null };
        const meta = memberMeta.get(uid);
        const guest = guestByHost.get(uid) ?? { guestCount: 0, guestAmount: 0 };
        const adjustments = adjustmentsByUser.get(uid) ?? 0;
        const adjDetail =
          adjustmentsDetail.get(uid) ??
          { total: 0, credits: 0, debits: 0, refunds: 0 };
        return {
          userId: uid,
          userName: meta?.name ?? uid,
          role: meta?.role ?? 'member',
          email: meta?.email ?? null,
          phone: meta?.phone ?? null,
          totalBill: agg.totalBill + guest.guestAmount,
          // Live-Test-5 ISSUE-4: own meal charges (incl. policy-billed
          // skipped/absent) as an independent component — guest charges are
          // never merged into meal charges (enterprise display policy).
          mealCharges: agg.totalBill,
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
          // Live-Test-5 ISSUE-4 (enterprise display policy): each financial
          // concept as its own line item — never merged. Signs per REF-001:
          // debit +, credit −(shown as deduction), refund + (credit returned).
          debitsTotal: adjDetail.debits,
          creditsTotal: adjDetail.credits,
          refundsTotal: adjDetail.refunds,
          // CREDIT-001: carried-forward opening balance — display item that
          // is ALREADY included in netBill (transparency line).
          openingBalance: openingByUser.get(uid) ?? 0,
          netBill:
            (openingByUser.get(uid) ?? 0) +
            agg.totalBill +
            guest.guestAmount +
            adjustments,
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
        // CREDIT-001: the finalized-period end date the opening balances were
        // carried through (null = nothing finalized before this range).
        openingCarriedThrough: opening.carriedThrough,
      },
      // SRS Module 03 (survey Q17/Q22): whether skipped/absent meals were
      // billed in this summary — additive, lets clients label the policy.
      billSkippedMeals: (groupPolicy as any)?.billSkippedMeals ?? false,
      // Live-Test-7 ISSUE-4: EFFECTIVE Absent policy (explicit toggle, or the
      // legacy coupling to Bill-Skip when unset) — additive display field.
      billAbsentMeals:
        ((groupPolicy as any)?.billAbsentMeals ??
          (groupPolicy as any)?.billSkippedMeals) === true,
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
        // Live-Test-5 ISSUE-4: itemised ledger components (group-wide).
        debitsTotal,
        creditsTotal,
        refundsTotal,
        // CREDIT-001: group-wide carried-forward total (display item — every
        // member netBill already includes their share).
        openingBalanceTotal,
        netRevenue: revenue + adjustmentsTotal,
        vacationDays,
      },
      mealBreakdown,
      slotBreakdown,
      members: memberList,
      // Pass 15 (FR-ANL-022): freshness stamp — cache HITs keep the original.
      generatedAt: new Date().toISOString(),
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

  // ── My billing (student, own bill) ────────────────────────────────────────

  /**
   * Issue 5 (FR-BILLX-043, "same value everywhere"): a member's OWN bill,
   * computed by the SAME engine as the admin Member-Billing dashboard, so the
   * student sees the identical net — meal charges + hosted-guest charges +
   * signed ledger adjustments (credits/refunds). Previously the student screen
   * summed only its own meal snapshots client-side, silently omitting guest
   * charges and admin credits, so its total could disagree with the admin's.
   *
   * We reuse getBillingSummary (same aggregation, same version-keyed cache) and
   * return ONLY the caller's row — no other member's figures or PII ever leave
   * the server. Isolation: the caller must be an active member of the group.
   */
  async getMyBilling(
    organizationId: string,
    userId: string,
    query: QueryBillingDto,
  ) {
    if (!query.groupId) {
      throw new BadRequestException({
        message: 'groupId is required',
        errors: { groupId: 'Provide a groupId query parameter' },
      });
    }

    // Live-Test-7 P0: an account with no organization cannot be an active
    // member of any group — return the same 403 the membership gate below
    // produces, instead of letting the org-scoped summary query throw first
    // (Prisma null-filter validation error → 500).
    if (!organizationId) {
      throw new ForbiddenException({
        message: 'You are not an active member of this group',
        errors: { groupId: 'No active membership' },
      });
    }

    // command_6 ultra pass: the self-membership gate and the (cached, org
    // scoped) group summary are independent — ONE parallel wave. The 403
    // still fires before anything is returned; only the caller's own row
    // ever leaves the server.
    const [membership, summary] = (await Promise.all([
      this.prisma.groupMember.findFirst({
        where: { groupId: query.groupId, userId, status: 'active' },
        select: { userId: true },
      }),
      this.getBillingSummary(organizationId, query),
    ])) as [unknown, any];
    if (!membership) {
      throw new ForbiddenException({
        message: 'You are not an active member of this group',
        errors: { groupId: 'No active membership' },
      });
    }
    const mine = (summary.members as any[]).find((m) => m.userId === userId);

    const totalBill = mine?.totalBill ?? 0; // meal + guest (pre-adjustment)
    const guestAmount = mine?.guestAmount ?? 0;
    const adjustmentsTotal = mine?.adjustmentsTotal ?? 0;

    return {
      period: summary.period,
      presentCount: mine?.presentCount ?? 0,
      skippedCount: mine?.skippedCount ?? 0,
      absentCount: mine?.absentCount ?? 0,
      vacationDays: mine?.vacationDays ?? 0,
      // Itemised so the student bill is explainable at a glance and reconciles
      // exactly with the admin: net = opening + mealCharges + guestAmount +
      // adjustments (CREDIT-001: opening balance included automatically).
      mealCharges: totalBill - guestAmount,
      guestCount: mine?.guestCount ?? 0,
      guestAmount,
      adjustmentsTotal,
      // Live-Test-5 ISSUE-4 (enterprise display policy): every financial
      // concept as its own line — Debits / Credits / Refunds never merged.
      debitsTotal: mine?.debitsTotal ?? 0,
      creditsTotal: mine?.creditsTotal ?? 0,
      refundsTotal: mine?.refundsTotal ?? 0,
      // Group policy flag so the client can label billed skipped/absent rows
      // ("Billed" vs "Not Billed") without a second request.
      billSkippedMeals: summary.billSkippedMeals ?? false,
      // Live-Test-7 ISSUE-4: effective Absent policy rides along (falls back
      // to the Skip flag exactly like the engine does when unset).
      billAbsentMeals: summary.billAbsentMeals ?? summary.billSkippedMeals ?? false,
      openingBalance: mine?.openingBalance ?? 0,
      totalBill,
      netBill: mine?.netBill ?? totalBill,
      generatedAt: summary.generatedAt,
    };
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
