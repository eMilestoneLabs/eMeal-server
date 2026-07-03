import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * BillingModule — SRS FR-DISP-010 (Pass 7): billing period finalization &
 * controlled reopen. Deliberately depends only on Prisma + Audit so the
 * AttendanceModule can import it for the period-lock write guard without any
 * circular-dependency risk.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
