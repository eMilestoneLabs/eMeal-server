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
    if (job.name !== JOB_TYPES.SYSTEM_DEFAULT_SWEEP) return;
    await this.sweep();
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
          user: { isVacationMode: false },
        },
        select: {
          userId: true,
          user: { select: { remindersEnabled: true, fcmToken: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { mealId, attendanceDate: dateUtc },
        select: { userId: true },
      }),
    ]);

    const already = new Set(existing.map((r) => r.userId));
    const eligible = members.filter(
      (m) =>
        !already.has(m.userId) &&
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
