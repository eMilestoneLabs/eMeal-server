import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { AuditModule } from '../../audit/audit.module';
import { GroupsModule } from '../groups/groups.module';
import { BillingModule } from '../billing/billing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NoticesModule } from '../notices/notices.module';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';

/**
 * GuestsModule — Module 22 (Pass 8): Member-Hosted Guests (+N).
 *
 * Import chain (deliberately NO AttendanceModule import — the attendance
 * service consumes GuestsService for FR-HG-035 reconciliation, so this module
 * must stay upstream of it to avoid a cycle):
 *   GroupsModule        → MembersRepository (host eligibility, FR-HG-043)
 *   BillingModule       → period lock (FR-DISP-010)
 *   NotificationsModule → host/admin pushes (FR-HG-062, FR-TRUST-011)
 */
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuditModule,
    GroupsModule,
    BillingModule,
    NotificationsModule,
    NoticesModule,
  ],
  controllers: [GuestsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
