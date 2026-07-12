import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { AuditModule } from '../../audit/audit.module';
import { StorageModule } from '../../storage/storage.module';
import { QueueModule } from '../../queue/queue.module';
import { BillingModule } from '../billing/billing.module';
import { NoticesModule } from '../notices/notices.module';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

/**
 * RetentionModule — SRS Module 03 RPT-009/010/011 + RET-001..015.
 *
 * Rolling billing-aware 3-month retention: reminder → grace → auto-finalize →
 * Excel+PDF archive to MinIO → notify admins → purge → reschedule. The sweep
 * itself is driven by the system-default worker (WorkersModule imports this
 * module for RetentionService); the controller serves the Reports → Data
 * Archives listing.
 */
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuditModule,
    StorageModule, // archive Excel/PDF objects live in MinIO (RET-010)
    QueueModule,   // best-effort push to group admins
    BillingModule, // period math + auto-finalize (RET-007)
    NoticesModule, // in-app bell reminders / Archive Ready alerts
  ],
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
