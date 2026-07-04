/**
 * attendance-reminder.worker.ts — B6 Phase
 *
 * Processes jobs from attendance-reminder-queue.
 *
 * Job types handled:
 *   dispatch-reminder — fired at scheduled time, pushes reminder to group members
 *
 * Rules enforced in worker (in addition to service-level checks):
 *   - Skip users with isVacationMode=true
 *   - Skip users with remindersEnabled=false
 *   - Skip users who have ALREADY marked attendance for this meal
 *   - Deduplicate using Redis setNx on dedupKey
 *
 * Idempotency: Redis key `reminder:dispatched:{dedupKey}` with 4-hour TTL.
 * If the key exists, the job was already processed — skip silently.
 *
 * LOOP-083 (Pass 15 verified): remindersEnabled is the per-user consent gate,
 * the Redis dedup key is the anti-spam suppressor, and already-marked members
 * are never pinged — no reminder fires without consent or twice per window.
 *
 * FR-MODE-050 (Pass 15 verified): reminders are scheduled per published
 * schedule entry / meal window — Attendance-Only groups (mealsEnabled=false)
 * have no published meal windows, so meal-driven reminders structurally
 * cannot fire for them; this worker's output is the attendance reminder,
 * which is the only reminder type AO groups may receive.
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { NotificationPayloadService } from '../features/notifications/services/notification-payload.service';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';
import type { ScheduleReminderPayload } from '../queue/interfaces/job-payload.interface';

const REMINDER_DEDUP_TTL = 4 * 60 * 60; // 4 hours

@Processor(QUEUE_NAMES.ATTENDANCE_REMINDER, { concurrency: 3 })
export class AttendanceReminderWorker extends WorkerHost {
  private readonly logger = new Logger(AttendanceReminderWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: QueueService,
    private readonly payloadBuilder: NotificationPayloadService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === JOB_TYPES.DISPATCH_REMINDER) {
      await this.handleDispatchReminder(job as Job<ScheduleReminderPayload>);
    }
  }

  private async handleDispatchReminder(job: Job<ScheduleReminderPayload>): Promise<void> {
    const { organizationId, groupId, mealId, mealSlotKey, minutesBefore, dedupKey } = job.data;

    // Security: org isolation
    if (!organizationId) {
      throw new Error(`[AttendanceReminderWorker] Missing organizationId job=${job.id}`);
    }

    // Idempotency: check if already dispatched
    const dispatchKey = `reminder:dispatched:${dedupKey}`;
    const alreadyDispatched = !(await this.redis.setDedup(dispatchKey, REMINDER_DEDUP_TTL));
    if (alreadyDispatched) {
      this.logger.debug(`Reminder already dispatched — skipping job=${job.id} meal=${mealId}`);
      return;
    }

    // Fetch active group members eligible for reminder
    // Rules: not on vacation, reminders enabled, has FCM token, NOT already attended
    // Build today's UTC date range for the attendance check
    // FIX: was passing a string slice to a DateTime field — type-unsafe.
    // Prisma DateTime requires Date objects for range filters.
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const tomorrowUtc = new Date(todayUtc);
    tomorrowUtc.setUTCDate(tomorrowUtc.getUTCDate() + 1);

    const [membersWithToken, alreadyAttended] = await Promise.all([
      this.prisma.groupMember.findMany({
        where: {
          groupId,
          status: 'active',
          user: {
            isVacationMode: false,
            remindersEnabled: true,
            fcmToken: { not: null },
          },
        },
        select: { userId: true, user: { select: { fcmToken: true } } },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          mealId,
          // FIX: proper Date range instead of string slice
          attendanceDate: { gte: todayUtc, lt: tomorrowUtc },
          status: { not: 'absent' },
        },
        select: { userId: true },
      }),
    ]);

    const attendedUserIds = new Set(alreadyAttended.map((r) => r.userId));

    const eligibleRecipients = membersWithToken
      .filter((m) => !attendedUserIds.has(m.userId) && m.user.fcmToken)
      .map((m) => ({ userId: m.userId, fcmToken: m.user.fcmToken! }));

    if (!eligibleRecipients.length) {
      this.logger.debug(
        `No eligible recipients for reminder job=${job.id} meal=${mealId} — all attended or opted out`,
      );
      return;
    }

    // Pass 15 (FR-NOTX-013): opt-out groups get "mark if absent" copy —
    // unmarked members are auto-marked Present at close (FR-TRUST-001).
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { attendanceDefault: true },
    });

    const payload = this.payloadBuilder.buildAttendanceReminderPayload({
      mealSlotKey,
      minutesRemaining: minutesBefore,
      defaultPresent: group?.attendanceDefault === 'present',
    });

    // Enqueue batch push to all eligible recipients
    await this.queue.enqueueBatchPush({
      organizationId,
      recipients: eligibleRecipients,
      title: payload.title,
      body: payload.body,
      route: payload.route,
      data: payload.data,
    });

    this.logger.log(
      `Reminder dispatched job=${job.id} meal=${mealId} slot=${mealSlotKey} ` +
      `${minutesBefore}min recipients=${eligibleRecipients.length}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `AttendanceReminder job FAILED job=${job.id} attempts=${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }
}
