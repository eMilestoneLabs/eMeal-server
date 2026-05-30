/**
 * notifications.module.ts — B6 Phase
 *
 * Provides:
 *   NotificationsController  — FCM token registration endpoints
 *   NotificationsService     — token lifecycle, reminder scheduling
 *   NotificationPayloadService — payload builders (Flutter-compatible)
 *   NotificationSendService   -- FCM send (MVP: log-only; B7: real FCM)
 *
 * Imports QueueModule so services can enqueue push jobs.
 * Exported so WorkersModule can inject NotificationSendService.
 */
import { Module } from '@nestjs/common';
import { QueueModule } from '../../queue/queue.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationPayloadService } from './services/notification-payload.service';
import { NotificationSendService } from './services/notification-send.service';

@Module({
  imports: [QueueModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationPayloadService, NotificationSendService],
  exports: [NotificationsService, NotificationPayloadService, NotificationSendService],
})
export class NotificationsModule {}
