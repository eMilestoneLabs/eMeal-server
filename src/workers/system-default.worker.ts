/**
 * system-default.worker.ts — Pass 7 (SRS FR-TRUST-001/002/003, Module 33).
 *
 * Materializes the OPT-OUT trust model: for groups with
 * attendanceDefault='present', once a meal's attendance window has fully
 * closed (close + grace), every active, non-vacation member WITHOUT a record
 * is marked Present with source='system_default' — standing consent under the
 * group's communicated policy.
 *
 * Fair-opportunity guarantees enforced per meal/member (FR-TRUST-003 —
 * fail-safe direction is always "do NOT auto-bill"):
 *   • the window must have been open ≥ minOptOutMinutes (group override or
 *     ATTENDANCE_MIN_OPT_OUT_MINUTES, default 30);
 *   • planner-mode groups: no published entry today = holiday → never billed
 *     (FR-MODE-032);
 *   • members on vacation or inactive are skipped;
 *   • if no reminder was dispatched for the meal (Redis
 *     reminder:dispatched:* flag from the reminder worker), only members who
 *     have reminders DISABLED are auto-marked — a member who was promised a
 *     reminder that never arrived is neutralized, not billed.
 *
 * Idempotency: createMany(skipDuplicates) against the NON-NEGOTIABLE
 * unique(userId, mealId, attendanceDate) — a member's own mark always wins;
 * re-runs are no-ops. Records are member-correctable via the auto-approving
 * correct_to_absent flow (FR-TRUST-002).
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../audit/audit.service';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';
import {
  toUtcMidnight,
  getCurrentTimeInTimezone,
  getWindowState,
} from '../common/utils/date.utils';
import { getVacationCoveredUserIds } from '../common/utils/vacation-coverage.util';

function todayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function windowMinutes(open: string, close: string): number {
  const [oh, om] = open.split(':').map(Number);
  const [ch, cm] = close.split(':').map(Number);
  const o = oh * 60 + om;
  const c = ch * 60 + cm;
  // Overnight windows wrap past midnight.
  return c >= o ? c - o : 24 * 60 - o + c;
}

@Processor(QUEUE_NAMES.SYSTEM_DEFAULT, { concurrency: 1 })
export class SystemDefaultWorker extends WorkerHost {
  private readonly logger = new Logger(SystemDefaultWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === JOB_TYPES.SYSTEM_DEFAULT_SWEEP) return this.sweep();
    // Pass 11 (FR-VACX-006): vacation flag lifecycle on the same queue.
    if (job.name === JOB_TYPES.VACATION_SWEEP) return this.vacationSweep();
    // Pass 14 (FR-EVT-054): expired-event cleanup fan-out on the same queue.
    if (job.name === JOB_TYPES.EVENT_CLEANUP_SWEEP) {
      return this.eventCleanupSweep();
    }
  }

  // ── Pass 14 (FR-EVT-054/FR-EVTX-023) — expired-event cleanup fan-out ──────
  //
  // Enqueues the existing per-org CLEANUP_EXPIRED_EVENTS job for every org
  // that has auto-delete events. cutoffDate is the UTC DATE (not instant) so
  // the jobId dedupes to one cleanup per org per day regardless of sweep
  // cadence; the cleanup itself is idempotent either way (LOOP-073).
  private async eventCleanupSweep(): Promise<void> {
    const orgs = await this.prisma.event.findMany({
      where: { autoDeleteAfter7Days: true },
      select: { organizationId: true },
      distinct: ['organizationId'],
    });
    if (orgs.length === 0) return;

    const cutoffDate = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const { organizationId } of orgs) {
      try {
        await this.queue.enqueueExpiredEventCleanup({
          organizationId,
          cutoffDate,
        });
        enqueued++;
      } catch (err) {
        // One org failing must not starve the rest — next sweep retries.
        this.logger.error(
          `Event-cleanup enqueue failed org=${organizationId}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Event-cleanup sweep fanned out to ${enqueued}/${orgs.length} org(s) cutoff=${cutoffDate}`,
    );
  }

  // ── Pass 11 (FR-VACX-006) — vacation flag lifecycle sweep ─────────────────
  //
  // Approved dated vacations drive isVacationMode deterministically even for
  // users who never open the app (read-time sync covers the ones who do):
  //   • activate: an approved request covers today (org timezone) → flag ON;
  //   • resume:   flag ON, user HAS approved requests, none covers today →
  //               flag OFF (the day after endDate, TZ-correct — ISSUE-5).
  // Pure-toggle users (no approved requests) are never touched (FR-VACX-001).

  private async vacationSweep(): Promise<void> {
    const now = new Date();
    // Candidate window: any request whose range could cover "today" in ANY
    // timezone (±1 day of UTC now) — tiny, indexed.
    const lo = new Date(now.getTime() - 2 * 86_400_000);
    const hi = new Date(now.getTime() + 2 * 86_400_000);

    const [flaggedUsers, activeRequests] = await Promise.all([
      this.prisma.user.findMany({
        where: { isVacationMode: true },
        select: { id: true, organizationId: true },
      }),
      (this.prisma as any).vacationRequest.findMany({
        where: {
          status: 'approved',
          deletedAt: null,
          startDate: { lte: hi },
          endDate: { gte: lo },
        },
        select: {
          userId: true,
          organizationId: true,
          startDate: true,
          endDate: true,
        },
      }) as Promise<
        Array<{
          userId: string;
          organizationId: string;
          startDate: Date;
          endDate: Date;
        }>
      >,
    ]);
    if (!flaggedUsers.length && !activeRequests.length) return;

    // Per-org "today" (UTC-midnight representation of the org business day).
    const orgIds = new Set<string>();
    for (const u of flaggedUsers) if (u.organizationId) orgIds.add(u.organizationId);
    for (const r of activeRequests) orgIds.add(r.organizationId);
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: [...orgIds] } },
      select: { id: true, timezone: true },
    });
    const todayByOrg = new Map<string, number>();
    for (const o of orgs) {
      todayByOrg.set(
        o.id,
        toUtcMidnight(todayInTimezone(o.timezone ?? 'Asia/Kolkata')).getTime(),
      );
    }

    const coversToday = (r: { organizationId: string; startDate: Date; endDate: Date }) => {
      const today = todayByOrg.get(r.organizationId);
      return (
        today !== undefined &&
        r.startDate.getTime() <= today &&
        r.endDate.getTime() >= today
      );
    };

    // Activations: covered today but flag OFF.
    const flaggedSet = new Set(flaggedUsers.map((u) => u.id));
    const toActivate = new Map<string, string>(); // userId → orgId
    for (const r of activeRequests) {
      if (coversToday(r) && !flaggedSet.has(r.userId)) {
        toActivate.set(r.userId, r.organizationId);
      }
    }

    // Resumes: flag ON, has approved requests, none covering today. Users
    // with NO approved requests in the candidate window may still have older
    // ones — resolve per user with one batched query.
    const coveredNow = new Set(
      activeRequests.filter(coversToday).map((r) => r.userId),
    );
    const resumeCandidates = flaggedUsers.filter(
      (u) => u.organizationId && !coveredNow.has(u.id) && !toActivate.has(u.id),
    );
    let toResume: Array<{ id: string; organizationId: string }> = [];
    if (resumeCandidates.length) {
      const withApproved: Array<{ userId: string }> = await (
        this.prisma as any
      ).vacationRequest.findMany({
        where: {
          userId: { in: resumeCandidates.map((u) => u.id) },
          status: 'approved',
          deletedAt: null,
        },
        select: { userId: true },
        distinct: ['userId'],
      });
      const requestDriven = new Set(withApproved.map((r) => r.userId));
      toResume = resumeCandidates.filter((u) =>
        requestDriven.has(u.id),
      ) as Array<{ id: string; organizationId: string }>;
    }

    if (toActivate.size) {
      await this.prisma.user.updateMany({
        where: { id: { in: [...toActivate.keys()] } },
        data: { isVacationMode: true },
      });
    }
    if (toResume.length) {
      await this.prisma.user.updateMany({
        where: { id: { in: toResume.map((u) => u.id) } },
        data: { isVacationMode: false },
      });
    }

    for (const [userId, orgId] of toActivate) {
      this.audit.log({
        organizationId: orgId,
        targetId: userId,
        targetType: 'User',
        action: AuditAction.update,
        metadata: { isVacationMode: true, reason: 'vacation sweep — approved range started (FR-VACX-006)' },
      });
    }
    for (const u of toResume) {
      this.audit.log({
        organizationId: u.organizationId,
        targetId: u.id,
        targetType: 'User',
        action: AuditAction.update,
        metadata: { isVacationMode: false, reason: 'vacation sweep — approved range ended (FR-VACX-006)' },
      });
    }
    if (toActivate.size || toResume.length) {
      this.logger.log(
        `Vacation sweep: activated=${toActivate.size} resumed=${toResume.length}`,
      );
    }
  }

  private async sweep(): Promise<void> {
    const groups = await this.prisma.group.findMany({
      where: { attendanceDefault: 'present', isActive: true },
      select: {
        id: true,
        organizationId: true,
        attendanceGraceMinutes: true,
        minOptOutMinutes: true,
        mealsEnabled: true,
        weeklyMenuEnabled: true,
        dayWiseMealsEnabled: true,
        organization: { select: { timezone: true } },
      },
    });
    if (!groups.length) return;

    const defaultFloor = this.config.get<number>(
      'attendance.minOptOutMinutes',
      30,
    );

    for (const group of groups) {
      try {
        await this.sweepGroup(group, defaultFloor);
      } catch (err) {
        // One bad group never blocks the rest of the sweep.
        this.logger.error(
          `System-default sweep failed group=${group.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async sweepGroup(
    group: {
      id: string;
      organizationId: string;
      attendanceGraceMinutes: number | null;
      minOptOutMinutes: number | null;
      mealsEnabled: boolean;
      weeklyMenuEnabled: boolean;
      dayWiseMealsEnabled: boolean;
      organization: { timezone: string | null } | null;
    },
    defaultFloor: number,
  ): Promise<void> {
    const tz = group.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = todayInTimezone(tz);
    const nowTime = getCurrentTimeInTimezone(tz);
    const dateUtc = toUtcMidnight(todayStr);
    const grace = Math.max(0, group.attendanceGraceMinutes ?? 0);
    const floor = group.minOptOutMinutes ?? defaultFloor;

    const [meals, entries] = await Promise.all([
      this.prisma.meal.findMany({
        where: {
          groupId: group.id,
          organizationId: group.organizationId,
          attendanceEnabled: true,
        },
        select: {
          id: true,
          name: true,
          attendanceWindowOpen: true,
          attendanceWindowClose: true,
          price: true,
        },
      }),
      this.prisma.scheduleEntry.findMany({
        where: {
          date: dateUtc,
          schedule: {
            groupId: group.id,
            organizationId: group.organizationId,
            isPublished: true,
          },
        },
        select: { mealId: true, openTime: true, closeTime: true, price: true },
      }),
    ]);
    if (!meals.length) return;

    const entryMap = new Map(entries.map((e) => [e.mealId, e]));
    const plannerActive =
      group.mealsEnabled !== false &&
      (group.weeklyMenuEnabled === true || group.dayWiseMealsEnabled === true);

    for (const meal of meals) {
      const entry = entryMap.get(meal.id);
      // FR-MODE-032: holiday / no-meal day in planner mode → never auto-bill.
      if (plannerActive && !entry) continue;

      const open = entry?.openTime ? entry.openTime : meal.attendanceWindowOpen;
      const close = entry?.openTime
        ? entry.closeTime
        : meal.attendanceWindowClose;
      if (!open || !close) continue; // no bounded window → no fair close point

      // Only materialize once the window (incl. grace) has fully closed.
      if (getWindowState(nowTime, open, close, grace) !== 'closed') continue;

      // FR-TRUST-003: the opt-out opportunity must have been real.
      if (windowMinutes(open, close) < floor) continue;

      await this.materializeMeal({
        group,
        mealId: meal.id,
        mealName: meal.name,
        dateUtc,
        dateStr: todayStr,
        price: entry?.price != null ? entry.price : (meal.price ?? null),
        openTime: open,
      });
    }
  }

  private async materializeMeal(params: {
    group: { id: string; organizationId: string };
    mealId: string;
    mealName: string;
    dateUtc: Date;
    dateStr: string;
    price: number | null;
    openTime: string | null;
  }): Promise<void> {
    const { group, mealId, dateUtc, dateStr, price } = params;

    // Sweep-level idempotency flag: each (meal, date) is materialized once —
    // members who mark/unmark afterwards are never re-defaulted, so a member
    // correction to Absent sticks (FR-TRUST-002).
    const onceKey = `sysdefault:done:${group.organizationId}:${mealId}:${dateStr}`;
    if (!(await this.redis.setDedup(onceKey, 48 * 60 * 60))) return;

    // FR-TRUST-003: was a reminder actually dispatched for this meal today?
    // (Flag set by AttendanceReminderWorker, 4h TTL — the sweep runs right
    // after close, well inside it.)
    const reminderSent =
      (await this.redis.exists(
        `reminder:dispatched:schedule-reminder:${group.organizationId}:${mealId}:30min`,
      )) ||
      (await this.redis.exists(
        `reminder:dispatched:schedule-reminder:${group.organizationId}:${mealId}:10min`,
      ));

    const [members, existing] = await Promise.all([
      this.prisma.groupMember.findMany({
        where: {
          groupId: group.id,
          status: 'active',
        },
        select: {
          userId: true,
          user: {
            select: {
              remindersEnabled: true,
              fcmToken: true,
              isVacationMode: true,
            },
          },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { mealId, attendanceDate: dateUtc },
        select: { userId: true },
      }),
    ]);

    // Pass 11 (FR-VACX-003/012): vacation exclusion is REQUEST-AWARE and
    // meal-granular — on a boundary day only the covered slots are exempt
    // from auto-billing; toggle-mode vacations exempt the whole day. Approved
    // requests govern even when the flag lags (never auto-bill a vacationer).
    const onVacation = await getVacationCoveredUserIds(this.prisma as any, {
      organizationId: group.organizationId,
      groupId: group.id,
      dateUtc,
      mealOpenTime: params.openTime,
      candidates: members.map((m) => ({
        userId: m.userId,
        isVacationMode: m.user.isVacationMode === true,
      })),
    });

    const already = new Set(existing.map((r) => r.userId));
    const eligible = members.filter(
      (m) =>
        !already.has(m.userId) &&
        !onVacation.has(m.userId) &&
        // No reminder went out → only members who waived reminders are
        // auto-marked; the rest are neutralized (fail-safe, FR-TRUST-003).
        (reminderSent || m.user.remindersEnabled === false),
    );
    if (!eligible.length) return;

    await this.prisma.attendanceRecord.createMany({
      data: eligible.map((m) => ({
        organizationId: group.organizationId,
        groupId: group.id,
        userId: m.userId,
        mealId,
        attendanceDate: dateUtc,
        status: 'present' as const,
        markedAt: new Date(),
        markedBy: null,
        price,
        source: 'system_default',
      })),
      skipDuplicates: true, // races with self-marks: the member always wins
    });

    // Per-record audit so FR-TRUST-010 change history shows the system entry.
    const created = await this.prisma.attendanceRecord.findMany({
      where: {
        mealId,
        attendanceDate: dateUtc,
        source: 'system_default',
        userId: { in: eligible.map((m) => m.userId) },
      },
      select: { id: true, userId: true },
    });
    for (const rec of created) {
      this.audit.log({
        organizationId: group.organizationId,
        targetId: rec.id,
        targetType: 'Attendance',
        action: AuditAction.create,
        metadata: {
          source: 'system_default',
          status: 'present',
          reason: 'Group opt-out policy — unmarked at window close',
        },
      });
    }

    // Invalidate the same read caches the attendance service maintains.
    const cacheKeys = [
      `attendance:group:${group.organizationId}:${group.id}:${dateStr}`,
      `attendance:meal:${group.organizationId}:${mealId}:${dateStr}`,
      ...created.map(
        (r) =>
          `attendance:summary:${group.organizationId}:${r.userId}:${group.id}`,
      ),
    ];
    try {
      await this.redis.del(...cacheKeys);
    } catch (_) {
      /* cache invalidation is best-effort */
    }

    // FR-TRUST-011: tell each affected member, with the easy way out.
    const byUser = new Map(members.map((m) => [m.userId, m]));
    const recipients = created
      .map((r) => byUser.get(r.userId))
      .filter((m) => m?.user.fcmToken)
      .map((m) => ({ userId: m!.userId, fcmToken: m!.user.fcmToken! }));
    if (recipients.length) {
      try {
        await this.queue.enqueueBatchPush({
          organizationId: group.organizationId,
          recipients,
          title: 'Marked Present by group policy',
          body:
            `${params.mealName} (${dateStr}): you were marked Present under your ` +
            'group’s opt-out policy. Didn’t eat? Correct it from the attendance screen.',
          route: '/attendance',
          data: { type: 'system_default_marked', mealId, date: dateStr },
        });
      } catch (err) {
        this.logger.warn(
          `system-default push enqueue failed: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `System-default sweep: group=${group.id} meal=${mealId} date=${dateStr} created=${created.length} reminderSent=${reminderSent}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `SystemDefault job FAILED job=${job.id} attempts=${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }
}
