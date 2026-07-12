import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../../storage/storage.module';

import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';
import { NoticesRepository } from './repositories/notices.repository';

/**
 * NoticesModule — Phase B in-app notice board + bell center (no FCM).
 *
 * Imports:
 *   PrismaModule   — Notice + NoticeRead access
 *   AuditModule    — audit logging for create/update/delete
 *   RealtimeModule — 'REALTIME_GATEWAY' token for notice.created.v1 emit
 *   NotificationsModule — best-effort push on publish (FR-NOTX-006 / ISSUE-15)
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    RealtimeModule,
    NotificationsModule,
    // SRS Module 03 NTC-012/013: notice attachments live in MinIO.
    StorageModule,
  ],
  controllers: [NoticesController],
  providers: [NoticesService, NoticesRepository],
  exports: [NoticesService, NoticesRepository],
})
export class NoticesModule {}
