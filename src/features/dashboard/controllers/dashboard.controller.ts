import {
  Controller,
  Get,
  Query,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../../common/decorators/current-user.decorator';
import { DashboardService } from '../services/dashboard.service';

/**
 * DashboardController — B5 dashboard and analytics endpoints.
 *
 * Endpoints:
 *   GET /api/v1/dashboard/student              — student dashboard (cached 2min)
 *   GET /api/v1/dashboard/admin                — admin operational dashboard (cached 3min)
 *   GET /api/v1/dashboard/analytics/attendance — attendance analytics by group + date range
 *
 * SECURITY: organizationId and userId from JWT (@CurrentUser) — NEVER from query/body.
 * FIX: Replaced req.user as any → @CurrentUser() user: JwtPayload to access user.sub
 *      (JWT payload field is `sub`, not `userId`).
 */
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('student')
  async getStudentDashboard(@CurrentUser() user: JwtPayload) {
    return this.dashboardService.getStudentDashboard(
      user.sub,           // FIX: was user.userId (undefined) — JWT payload uses `sub`
      user.organizationId!,
      user.role,
    );
  }

  @Get('admin')
  async getAdminDashboard(@CurrentUser() user: JwtPayload) {
    return this.dashboardService.getAdminDashboard(
      user.sub,           // FIX: was user.userId (undefined) — JWT payload uses `sub`
      user.organizationId!,
      user.role,
    );
  }

  @Get('analytics/attendance')
  async getAttendanceAnalytics(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId: string,
    @Query('fromDate') fromDate: string,
    @Query('toDate') toDate: string,
  ) {
    if (!groupId) {
      throw new BadRequestException({
        message: 'groupId is required',
        errors: { groupId: 'Provide a groupId query parameter' },
      });
    }
    if (!fromDate || !toDate) {
      throw new BadRequestException({
        message: 'fromDate and toDate are required',
        errors: { fromDate: 'Provide both fromDate and toDate as YYYY-MM-DD' },
      });
    }

    // FIX: was passing user.userId as organizationId (undefined) and
    //      user.organizationId as role — parameter order was completely wrong.
    //      Corrected: organizationId first, role second.
    return this.dashboardService.getAttendanceAnalytics(
      user.organizationId!,   // FIX: was user.userId (undefined)
      user.role,               // FIX: was user.organizationId (wrong field)
      groupId,
      fromDate,
      toDate,
    );
  }
}
