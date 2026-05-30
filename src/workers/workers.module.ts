/**
 * workers.module.ts — B6 Phase
 *
 * Registers all 4 BullMQ worker processors.
 *
 * Workers are bound to their queues via @Processor() decorator.
 * QueueModule provides the BullMQ connection and Queue instances.
 * NotificationsModule provides NotificationSendService and payload builders.
 *
 * Worker lifecycle:
 *   - NestJS bootstraps workers as part of the main process (single-process)
 *   - In production: consider PM2 cluster or separate worker process via
 *     `nest start --entryFile worker-main` for CPU isolation
 *   - All workers share the same Prisma + Redis connection pool
 */

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationWorker } from './notification.worker';
import { AttendanceReminderWorker } from './attendance-reminder.worker';
import { AnalyticsAggregationWorker } from './analytics-aggregation.worker';
import { CleanupWorker } from './cleanup.worker';
import { ExportWorker } from './export.worker';
import { QueueModule } from '../queue/queue.module';
import { NotificationsModule } from '../features/notifications/notifications.module';
import { QUEUE_NAMES } from '../queue/constants/queue.constants';

@Module({
  imports: [
    QueueModule,
    NotificationsModule,

    // BullMQ requires queue registration in the consuming module as well
    BullModule.registerQueue(
      { name: QUEUE_NAMES.NOTIFICATION },
      { name: QUEUE_NAMES.ATTENDANCE_REMINDER },
      { name: QUEUE_NAMES.ANALYTICS },
      { name: QUEUE_NAMES.EXPORT },
      { name: QUEUE_NAMES.CLEANUP },
    ),
  ],

  providers: [
    NotificationWorker,
    AttendanceReminderWorker,
    AnalyticsAggregationWorker,
    CleanupWorker,
    ExportWorker,
  ],
})
export class WorkersModule {}
