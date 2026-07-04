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
      return;
    }
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
}
