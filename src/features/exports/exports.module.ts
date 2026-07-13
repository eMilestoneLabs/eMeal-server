import { Module } from '@nestjs/common';
import { ExportsController } from './controllers/exports.controller';
import { ExportsService } from './services/exports.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  // CREDIT-001 (command_6): BillingModule provides the opening-balance engine
  // so exports reconcile exactly with the billing-summary API.
  imports: [PrismaModule, AuditModule, BillingModule],
  controllers: [ExportsController],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
