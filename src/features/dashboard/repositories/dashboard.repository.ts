import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  StudentDashboardEntity,
  AdminDashboardEntity,
  AttendanceAnalyticsEntity,
  UpcomingMealItem,
  TodayAttendanceItem,
  AttendanceSummary,
  ActiveGroupItem,
  TodayAttendanceCounts,
  MealParticipationItem,
  RecentActivityItem,
} from '../entities/dashboard.entity';

/**
 * DashboardRepository — read-heavy queries for dashboard aggregation.
 *
 * Multi-tenant: organizationId always from JWT.
 * All aggregations use raw Prisma groupBy or findMany with count — no Prisma rates.
 * Flutter computes rates from returned counts.
 */
@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  // PERF (additive): cache org timezone in-process (it effectively never
  // changes) to skip a per-cache-miss PK lookup. 5-min TTL self-heals if an
  // org timezone is ever changed. Per-worker cache (PM2 cluster) — fine.
  private static readonly _tzCache = new Map<string, { tz: string; expires: number }>();
  private static readonly _TZ_TTL_MS = 5 * 60 * 1000;

  // Pass 15 (FR-ANL-011): public — the service layer uses this to default
  // analytics date ranges in the ORG timezone instead of device/UTC time.
  async getOrgTimezone(organizationId: string): Promise<string> {
    // Live-Test-7 P0: org-less accounts (pre-join) — findUnique with a null
    // id throws (500). Use the same default the lookup below falls back to.
    if (!organizationId) return 'Asia/Kolkata';
    const now = Date.now();
    const hit = DashboardRepository._tzCache.get(organizationId);
    if (hit && hit.expires > now) return hit.tz;
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const tz = org?.timezone ?? 'Asia/Kolkata';
    DashboardRepository._tzCache.set(organizationId, { tz, expires: now + DashboardRepository._TZ_TTL_MS });
    return tz;
  }

  /**
   * Today's UTC-midnight bounds computed in the ORGANIZATION's timezone, so
   * "today" matches how attendance stores attendanceDate (org-local date).
   * Fixes admin/student counts reading 0 near midnight when the UTC date
   * differs from the org-local date (e.g. 02:21 IST = previous UTC day).
   */
  private async getTodayBoundsInOrgTz(
    organizationId: string,
  ): Promise<{ todayUtc: Date; tomorrowUtc: Date }> {
    const tz = await this.getOrgTimezone(organizationId);
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [yy, mm, dd] = todayStr.split('-').map(Number);
    const todayUtc = new Date(Date.UTC(yy, mm - 1, dd));
    const tomorrowUtc = new Date(todayUtc);
    tomorrowUtc.setUTCDate(tomorrowUtc.getUTCDate() + 1);
    return { todayUtc, tomorrowUtc };
  }

  // ─── STUDENT DASHBOARD ────────────────────────────────────────────────────

  async buildStudentDashboard(
    userId: string,
    organizationId: string,
  ): Promise<StudentDashboardEntity> {
    // Live-Test-7 P0: accounts that have not joined a group yet carry no
    // organizationId — every org-scoped query below would throw on the null
    // non-nullable filter (500). Serve the identical contract with empty
    // operational data + the user's own flags so the "join a group" home
    // screen renders instead of an error state. ONE indexed point read.
    if (!organizationId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { isVacationMode: true, isDefaultAttendance: true },
      });
      return new StudentDashboardEntity({
        userId,
        organizationId: '',
        upcomingMeals: [],
        todayAttendance: [],
        weeklyMeals: [],
        notifications: [],
        attendanceSummary: {
          totalDays: 0,
          presentDays: 0,
          absentDays: 0,
          skippedDays: 0,
          vacationDays: 0,
        },
        activeGroups: [],
        vacationMode: user?.isVacationMode ?? false,
        defaultAttendanceMode: user?.isDefaultAttendance ?? false,
        generatedAt: new Date().toISOString(),
      });
    }
    const { todayUtc } = await this.getTodayBoundsInOrgTz(organizationId);

    // PERF (additive): the 30-day summary depends only on userId/org/date — not
    // on meals or today-records — so kick it off now and await it later. It runs
    // concurrently with the meal + records queries instead of after them (~1 RTT
    // saved on a cache miss). Identical query, identical result.
    const thirtyDaysAgo = new Date(todayUtc);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const attendanceSummaryPromise = this.prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: {
        userId,
        organizationId,
        attendanceDate: { gte: thirtyDaysAgo, lte: todayUtc },
      },
      _count: { status: true },
    });

    // Fetch user preferences + group memberships in parallel
    const [user, groupMemberships] = await this.prisma.$transaction([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { isVacationMode: true, isDefaultAttendance: true },
      }),
      this.prisma.groupMember.findMany({
        where: { userId, status: 'active' },
        include: { group: { select: { id: true, name: true, type: true, mealsEnabled: true } } },
      }),
    ]);

    const activeGroupIds = groupMemberships.map((gm: any) => gm.group.id);

    const activeGroups: ActiveGroupItem[] = groupMemberships.map((gm: any) => ({
      groupId: gm.group.id,
      groupName: gm.group.name,
      groupType: gm.group.type,
      mealsEnabled: gm.group.mealsEnabled,
    }));

    // Today's meals for all active groups
    const todayMeals = await this.prisma.meal.findMany({
      where: {
        organizationId,
        groupId: { in: activeGroupIds },
        isActive: true,
      },
      orderBy: { order: 'asc' },
      select: {
        id: true,
        slotKey: true,
        name: true,
        displayName: true,
        attendanceWindowOpen: true,
        attendanceWindowClose: true,
      },
    });

    // Today's attendance records for this user
    const todayRecords = await this.prisma.attendanceRecord.findMany({
      where: {
        userId,
        organizationId,
        mealId: { in: todayMeals.map((m: any) => m.id) },
        attendanceDate: todayUtc,
      },
      select: { mealId: true, status: true },
    });

    const recordMap = new Map(todayRecords.map((r: any) => [r.mealId, r.status]));

    const todayAttendance: TodayAttendanceItem[] = todayMeals.map((m: any) => ({
      mealId: m.id,
      slotKey: m.slotKey,
      displayName: m.displayName ?? m.name,
      status: recordMap.get(m.id) ?? null,
    }));

    const upcomingMeals: UpcomingMealItem[] = todayMeals.map((m: any) => ({
      mealId: m.id,
      slotKey: m.slotKey,
      displayName: m.displayName ?? m.name,
      attendanceWindowOpen: m.attendanceWindowOpen,
      attendanceWindowClose: m.attendanceWindowClose,
      isAttended: recordMap.has(m.id) ? recordMap.get(m.id) === 'present' : null,
    }));

    // 30-day attendance summary (started earlier; await its result now)
    const attendanceSummaryRaw = await attendanceSummaryPromise;

    const summaryMap = new Map(
      attendanceSummaryRaw.map((r: any) => [r.status, r._count.status]),
    );

    const attendanceSummary: AttendanceSummary = {
      totalDays: Array.from(summaryMap.values()).reduce((a, b) => a + b, 0),
      presentDays: summaryMap.get('present') ?? 0,
      absentDays: summaryMap.get('absent') ?? 0,
      skippedDays: summaryMap.get('skipped') ?? 0,
      vacationDays: summaryMap.get('onVacation') ?? 0,
    };

    return new StudentDashboardEntity({
      userId,
      organizationId,
      upcomingMeals,
      todayAttendance,
      attendanceSummary,
      activeGroups,
      vacationMode: user?.isVacationMode ?? false,
      defaultAttendanceMode: user?.isDefaultAttendance ?? false,
      generatedAt: new Date().toISOString(),
    });
  }

  // ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────

  async buildAdminDashboard(organizationId: string): Promise<AdminDashboardEntity> {
    const { todayUtc, tomorrowUtc } =
      await this.getTodayBoundsInOrgTz(organizationId);

    // Parallel queries for dashboard aggregation
    const [
      groupCount,
      activeMemberCount,
      activeMealCount,
      activeScheduleCount,
      todayAttendanceRaw,
      todayMeals,
      recentAuditLogs,
    ] = await this.prisma.$transaction([
      // Group count
      this.prisma.group.count({ where: { organizationId, isActive: true } }),

      // Active unique members across all groups
      this.prisma.groupMember.count({
        where: { group: { organizationId }, status: 'active' },
      }),

      // Active meals
      this.prisma.meal.count({ where: { organizationId, isActive: true } }),

      // Active (published) schedules
      this.prisma.mealSchedule.count({
        where: { organizationId, isPublished: true },
      }),

      // Today's attendance grouped by status
      this.prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: {
          organizationId,
          attendanceDate: { gte: todayUtc, lt: tomorrowUtc },
        },
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),

      // Today's active meals (for participation tracking)
      this.prisma.meal.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, name: true, displayName: true, slotKey: true },
        take: 20,
        orderBy: { order: 'asc' },
      }),

      // Recent audit logs — last 10 actions
      this.prisma.auditLog.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { actor: { select: { name: true } } },
      }),
    ]);

    // Build attendance counts map
    const attendanceMap = new Map(
      todayAttendanceRaw.map((r: any) => [r.status, r._count.status]),
    );

    const todayAttendance: TodayAttendanceCounts = {
      present: attendanceMap.get('present') ?? 0,
      absent: attendanceMap.get('absent') ?? 0,
      skipped: attendanceMap.get('skipped') ?? 0,
      pending: activeMemberCount - Array.from(attendanceMap.values()).reduce((a, b) => a + b, 0),
    };
    // pending cannot be negative
    if (todayAttendance.pending < 0) todayAttendance.pending = 0;

    // Meal participation — count present records per meal today
    const mealParticipationRaw = await this.prisma.attendanceRecord.groupBy({
      by: ['mealId'],
      where: {
        organizationId,
        status: 'present',
        attendanceDate: { gte: todayUtc, lt: tomorrowUtc },
        mealId: { in: todayMeals.map((m: any) => m.id) },
      },
      _count: { mealId: true },
    });

    const mealCountMap = new Map(
      mealParticipationRaw.map((r: any) => [r.mealId, r._count.mealId]),
    );

    const mealParticipation: MealParticipationItem[] = todayMeals.map((m: any) => ({
      mealId: m.id,
      mealName: m.displayName ?? m.name,
      slotKey: m.slotKey,
      count: mealCountMap.get(m.id) ?? 0,
    }));

    // Recent activity from audit logs
    const recentActivity: RecentActivityItem[] = recentAuditLogs.map((log: any) => ({
      type: log.action,
      actorName: log.actor?.name ?? null,
      targetName: log.targetType,
      happenedAt: log.createdAt.toISOString(),
    }));

    return new AdminDashboardEntity({
      organizationId,
      groupCount,
      memberCount: activeMemberCount,
      activeMeals: activeMealCount,
      activeSchedules: activeScheduleCount,
      todayAttendance,
      mealParticipation,
      recentActivity,
      generatedAt: new Date().toISOString(),
    });
  }

  // ─── ATTENDANCE ANALYTICS ─────────────────────────────────────────────────

  async buildAttendanceAnalytics(
    organizationId: string,
    groupId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<AttendanceAnalyticsEntity> {
    // Total active members in group
    const memberCount = await this.prisma.groupMember.count({
      where: { groupId, status: 'active' },
    });

    // Daily breakdown — group by attendanceDate + status
    const dailyRaw = await this.prisma.attendanceRecord.groupBy({
      by: ['attendanceDate', 'status'],
      where: {
        organizationId,
        groupId,
        attendanceDate: { gte: fromDate, lte: toDate },
      },
      _count: { status: true },
    });

    // Build daily breakdown map: date → status → count
    const dailyMap = new Map<string, Record<string, number>>();
    for (const r of dailyRaw) {
      const dateStr = toDateString(r.attendanceDate);
      if (!dailyMap.has(dateStr)) {
        dailyMap.set(dateStr, { present: 0, absent: 0, skipped: 0, onVacation: 0 });
      }
      dailyMap.get(dateStr)![r.status as string] = (r as any)._count.status;
    }

    const dailyBreakdown = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({
        date,
        present: counts.present ?? 0,
        absent: counts.absent ?? 0,
        skipped: counts.skipped ?? 0,
        onVacation: counts.onVacation ?? 0,
      }));

    // Slot breakdown — group by mealId + status, then resolve meal slotKey
    const slotRaw = await this.prisma.attendanceRecord.groupBy({
      by: ['mealId', 'status'],
      where: {
        organizationId,
        groupId,
        attendanceDate: { gte: fromDate, lte: toDate },
      },
      _count: { status: true },
    });

    const mealIds = [...new Set(slotRaw.map((r: any) => r.mealId))];
    const meals = await this.prisma.meal.findMany({
      where: { id: { in: mealIds as string[] } },
      select: { id: true, slotKey: true, name: true, displayName: true },
    });
    const mealMap = new Map(meals.map((m: any) => [m.id, m]));

    // Build slot breakdown per meal
    const slotCountMap = new Map<string, { slotKey: string; displayName: string; present: number; absent: number; skipped: number }>();
    for (const r of slotRaw) {
      const meal = mealMap.get(r.mealId);
      if (!meal) continue;
      if (!slotCountMap.has(r.mealId)) {
        slotCountMap.set(r.mealId, {
          slotKey: meal.slotKey,
          displayName: meal.displayName ?? meal.name,
          present: 0,
          absent: 0,
          skipped: 0,
        });
      }
      const entry = slotCountMap.get(r.mealId)!;
      const count = (r as any)._count.status;
      if (r.status === 'present') entry.present += count;
      else if (r.status === 'absent') entry.absent += count;
      else if (r.status === 'skipped') entry.skipped += count;
    }

    return new AttendanceAnalyticsEntity({
      organizationId,
      groupId,
      fromDate: toDateString(fromDate),
      toDate: toDateString(toDate),
      totalMembers: memberCount,
      dailyBreakdown,
      slotBreakdown: Array.from(slotCountMap.values()),
      generatedAt: new Date().toISOString(),
    });
  }
}

function toDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
