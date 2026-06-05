import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ExportsModule } from '../exports/exports.module';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
  imports: [ExportsModule, DashboardModule],
  controllers: [ReportsController],
})
export class ReportsModule {}
