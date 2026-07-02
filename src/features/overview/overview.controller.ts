import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { OverviewService } from './overview.service';
import { QueryOverviewDto } from './dto/query-overview.dto';

const ADMIN_ROLES = [
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
] as const;

/**
 * OverviewController — additive aggregate endpoint.
 *
 *   GET /api/v1/dashboard/admin/overview?date=YYYY-MM-DD
 *
 * Returns groups + today's meals + per-meal summaries + recent activity in a
 * single response so the Flutter admin dashboard cold load costs ONE network
 * round-trip instead of three sequential request waves. Lives in its own
 * module (not DashboardModule) because AttendanceModule already imports
 * DashboardModule for cache invalidation — importing AttendanceModule from
 * DashboardModule would create a circular module dependency.
 *
 * SECURITY: organizationId/userId/role from JWT only; admin roles required —
 * exactly the guards the composed endpoints enforce individually.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
@Controller('dashboard')
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get('admin/overview')
  async getAdminOverview(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryOverviewDto,
  ) {
    if (!user.organizationId) {
      return {
        groups: { data: [], total: 0, page: 1, limit: 100 },
        todayMeals: [],
        mealSummaries: [],
        recentActivity: [],
        date: query.date ?? new Date().toISOString().slice(0, 10),
        generatedAt: new Date().toISOString(),
      };
    }
    return this.overviewService.getAdminOverview(
      user.sub,
      user.role,
      user.organizationId,
      query.date,
    );
  }
}
