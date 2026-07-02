import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { GroupsModule } from '../groups/groups.module';
import { MealsModule } from '../meals/meals.module';
import { AttendanceModule } from '../attendance/attendance.module';

/**
 * OverviewModule — read-only aggregate endpoints that COMPOSE other feature
 * services (no business logic of its own, no repository, no cache keys).
 *
 * Deliberately separate from DashboardModule: AttendanceModule imports
 * DashboardModule (for cache invalidation), so the aggregate — which needs
 * AttendanceService — must sit outside DashboardModule to avoid a circular
 * module dependency.
 */
@Module({
  imports: [GroupsModule, MealsModule, AttendanceModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
