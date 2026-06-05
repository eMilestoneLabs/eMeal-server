/**
 * queue-metrics.controller.ts — B6 Phase
 *
 * GET /api/v1/admin/queues/stats
 *
 * Returns per-queue job counts (waiting, active, completed, failed, delayed).
 * Admin-only endpoint — protected by JwtAuthGuard + AdminRoleGuard.
 *
 * B6 requirement: "Add GET /admin/queues/stats endpoint"
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { QUEUE_NAMES } from './constants/queue.constants';

interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('hostelAdmin', 'organizationManager', 'hostelManager', 'messManager')
@Controller('admin/queues')
export class QueueMetricsController {
  constructor(
    @InjectQueue(QUEUE_NAMES.NOTIFICATION) private readonly notificationQueue: Queue,
    @InjectQueue(QUEUE_NAMES.ATTENDANCE_REMINDER) private readonly reminderQueue: Queue,
    @InjectQueue(QUEUE_NAMES.ANALYTICS) private readonly analyticsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EXPORT) private readonly exportQueue: Queue,
    @InjectQueue(QUEUE_NAMES.CLEANUP) private readonly cleanupQueue: Queue,
  ) {}

  /**
   * GET /api/v1/admin/queues/stats
   * Returns job counts for all 5 queues.
   */
  @Get('stats')
  async getQueueStats(): Promise<{ queues: QueueStats[]; generatedAt: string }> {
    const queues = await Promise.all([
      this.getQueueStat(this.notificationQueue, QUEUE_NAMES.NOTIFICATION),
      this.getQueueStat(this.reminderQueue, QUEUE_NAMES.ATTENDANCE_REMINDER),
      this.getQueueStat(this.analyticsQueue, QUEUE_NAMES.ANALYTICS),
      this.getQueueStat(this.exportQueue, QUEUE_NAMES.EXPORT),
      this.getQueueStat(this.cleanupQueue, QUEUE_NAMES.CLEANUP),
    ]);

    return {
      queues,
      generatedAt: new Date().toISOString(),
    };
  }

  private async getQueueStat(queue: Queue, name: string): Promise<QueueStats> {
    const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
      queue.getJobCountByTypes('paused'),
    ]);

    return { name, waiting, active, completed, failed, delayed, paused };
  }
}
