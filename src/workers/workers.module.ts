/**
 * workers.module.ts — B6 Phase
 *
 * Registers all BullMQ worker processors.
 *
 * Workers are bound to their queues via @Processor() decorator.
 * QueueModule provides the BullMQ connection and Queue instances.
 * NotificationsModule provides NotificationSendService and payload builders.
 */

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationWorker } from './notification.worker';
import { AttendanceReminderWorker } from './attendance-reminder.worker';
import { AnalyticsAggregationWorker } from './analytics-aggregation.worker';
import { CleanupWorker } from './cleanup.worker';
import { ExportWorker } from './export.worker';
import { SchedulePublishWorker } from './schedule-publish.worker';
import { StaleTokenWorker } from './stale-token.worker';
import { OrphanWorker } from './orphan.worker';
import { QueueModule } from '../queue/queue.module';
import { NotificationsModule } from '../features/notifications/notifications.module';
import { QUEUE_NAMES } from '../queue/constants/queue.constants';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    QueueModule,
    NotificationsModule,
    PrismaModule,

    // BullMQ requires queue registration in the consuming module as well
    BullModule.registerQueue(
      { name: QUEUE_NAMES.NOTIFICATION },
      { name: QUEUE_NAMES.ATTENDANCE_REMINDER },
      { name: QUEUE_NAMES.ANALYTICS },
      { name: QUEUE_NAMES.EXPORT },
      { name: QUEUE_NAMES.CLEANUP },
      { name: QUEUE_NAMES.SCHEDULE_PUBLISH },
    ),
  ],

  providers: [
    NotificationWorker,
    AttendanceReminderWorker,
    AnalyticsAggregationWorker,
    CleanupWorker,
    ExportWorker,
    SchedulePublishWorker,   // B6 gap: deferred schedule publish jobs
    StaleTokenWorker,        // B6 gap: expired refresh token + OTP cleanup
    OrphanWorker,            // B6 gap: auto-delete events + orphaned guest parties
  ],
})
export class WorkersModule {}
