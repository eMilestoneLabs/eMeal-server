/**
 * system-default.scheduler.ts — Pass 7 (SRS FR-TRUST-001).
 *
 * Registers the repeatable system-default sweep job on application bootstrap.
 * BullMQ stores repeatable-job definitions in Redis keyed by (name + repeat
 * options), so all PM2 cluster workers registering the same definition is
 * idempotent — exactly one sweep fires per interval across the cluster.
 *
 * Cadence: ATTENDANCE_SYSTEM_DEFAULT_SWEEP_MINUTES (default 10; 0 disables).
 * Groups without attendanceDefault='present' are never touched, so the sweep
 * is a cheap single indexed query for opt-in-only deployments.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';

@Injectable()
export class SystemDefaultSweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemDefaultSweepScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.SYSTEM_DEFAULT)
    private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const everyMinutes = this.config.get<number>(
      'attendance.systemDefaultSweepMinutes',
      10,
    );
    if (!everyMinutes || everyMinutes <= 0) {
      this.logger.log('System-default sweep disabled (interval = 0)');
    } else {
      try {
        await this.queue.add(
          JOB_TYPES.SYSTEM_DEFAULT_SWEEP,
          {},
          {
            repeat: { every: everyMinutes * 60_000 },
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 20 },
          },
        );
        this.logger.log(
          `System-default sweep scheduled every ${everyMinutes} minute(s)`,
        );
      } catch (err) {
        // Never block app startup on queue availability.
        this.logger.error(
          `Failed to schedule system-default sweep: ${(err as Error).message}`,
        );
      }
    }

    // Pass 11 (FR-VACX-006): vacation flag lifecycle sweep — same queue,
    // distinct repeatable job. Registration is idempotent across the cluster.
    const vacationMinutes = this.config.get<number>(
      'attendance.vacationSweepMinutes',
      30,
    );
    if (!vacationMinutes || vacationMinutes <= 0) {
      this.logger.log('Vacation sweep disabled (interval = 0)');
    } else {
      try {
        await this.queue.add(
          JOB_TYPES.VACATION_SWEEP,
          {},
          {
            repeat: { every: vacationMinutes * 60_000 },
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 20 },
          },
        );
        this.logger.log(
          `Vacation sweep scheduled every ${vacationMinutes} minute(s)`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to schedule vacation sweep: ${(err as Error).message}`,
        );
      }
    }

    // Pass 14 (FR-EVT-054/FR-EVTX-023): expired-event cleanup trigger. The
    // per-org cleanup job existed since Phase B but nothing ever enqueued it —
    // this sweep fans out one day-deduped job per org so the deactivate +
    // 7-day hard-purge actually fires.
    const eventCleanupMinutes = this.config.get<number>(
      'attendance.eventCleanupSweepMinutes',
      360,
    );
    if (!eventCleanupMinutes || eventCleanupMinutes <= 0) {
      this.logger.log('Event-cleanup sweep disabled (interval = 0)');
    } else {
      try {
        await this.queue.add(
          JOB_TYPES.EVENT_CLEANUP_SWEEP,
          {},
          {
            repeat: { every: eventCleanupMinutes * 60_000 },
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 20 },
          },
        );
        this.logger.log(
          `Event-cleanup sweep scheduled every ${eventCleanupMinutes} minute(s)`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to schedule event-cleanup sweep: ${(err as Error).message}`,
        );
      }
    }

    // Pass 15 (FR-NOTX-010): weekly attendance summary digest. The sweep
    // itself is cheap (one indexed groups query + an hour/day gate per group);
    // each group dispatches at most once per digest day via a Redis once-flag.
    const digestMinutes = this.config.get<number>(
      'attendance.weeklyDigestSweepMinutes',
      60,
    );
    if (!digestMinutes || digestMinutes <= 0) {
      this.logger.log('Weekly-digest sweep disabled (interval = 0)');
    } else {
      try {
        await this.queue.add(
          JOB_TYPES.WEEKLY_DIGEST_SWEEP,
          {},
          {
            repeat: { every: digestMinutes * 60_000 },
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 20 },
          },
        );
        this.logger.log(
          `Weekly-digest sweep scheduled every ${digestMinutes} minute(s)`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to schedule weekly-digest sweep: ${(err as Error).message}`,
        );
      }
    }

    // Pass 15 (FR-NOTX-010): attendance-reminder scheduling sweep — the
    // 30/10-min pre-close reminder producer had no caller since B6, so the
    // reminder pipeline never fired. Enqueue-side jobId dedup + the dispatch
    // worker's Redis flag make the repeats idempotent.
    const reminderMinutes = this.config.get<number>(
      'attendance.reminderScheduleSweepMinutes',
      15,
    );
    if (!reminderMinutes || reminderMinutes <= 0) {
      this.logger.log('Reminder-schedule sweep disabled (interval = 0)');
      return;
    }
    try {
      await this.queue.add(
        JOB_TYPES.REMINDER_SCHEDULE_SWEEP,
        {},
        {
          repeat: { every: reminderMinutes * 60_000 },
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 20 },
        },
      );
      this.logger.log(
        `Reminder-schedule sweep scheduled every ${reminderMinutes} minute(s)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to schedule reminder-schedule sweep: ${(err as Error).message}`,
      );
    }
  }
}
