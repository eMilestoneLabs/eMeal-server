import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { NoticesModule } from '../notices/notices.module';
import { BillingController, BillingMemberController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * BillingModule — SRS FR-DISP-010 (Pass 7): billing period finalization &
 * controlled reopen. Deliberately depends only on Prisma + Audit so the
 * AttendanceModule can import it for the period-lock write guard without any
 * circular-dependency risk.
 */
@Module({
  // command_6 (survey 2026-07-13): NoticesModule (leaf module — no billing
  // dependency, cycle-free) powers the member-consent debit bell alert;
  // BillingMemberController carries the member-side approval routes.
  imports: [PrismaModule, AuditModule, NoticesModule],
  controllers: [BillingController, BillingMemberController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
