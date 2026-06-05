import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, ALL_ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { ExportsService } from '../exports/services/exports.service';
import { DashboardService } from '../dashboard/services/dashboard.service';
import { AttendanceExportQueryDto, EventExportQueryDto } from '../exports/dto/export-query.dto';

/**
 * ReportsController — Flutter /reports/* endpoint contracts.
 *
 * Flutter api_endpoints.dart:
 *   GET /reports/attendance/pdf   → exportPdf
 *   GET /reports/attendance/excel → exportExcel
 *   GET /reports/analytics        → analyticsSummary
 *   GET /reports/meals            → mealAnalytics
 *
 * These are aliases to the existing /exports and /dashboard/analytics endpoints.
 * Kept as separate controller so Flutter contracts are preserved without
 * renaming existing backend routes (additive-safe).
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ALL_ADMIN_ROLES)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly exportsService: ExportsService,
    private readonly dashboardService: DashboardService,
  ) {}

  // ── GET /reports/attendance/pdf ────────────────────────────────────────────
  // Flutter: String get exportPdf => '/reports/attendance/pdf'
  // Returns raw attendance records for Flutter PDF generation (not a real PDF).

  @Get('attendance/pdf')
  async exportAttendancePdf(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: AttendanceExportQueryDto,
  ) {
    return this.exportsService.exportAttendance(
      user.sub,
      user.organizationId!,
      user.role,
      query,
      res,
      req.headers['x-request-id'] as string,
    );
  }

  // ── GET /reports/attendance/excel ──────────────────────────────────────────
  // Flutter: String get exportExcel => '/reports/attendance/excel'

  @Get('attendance/excel')
  async exportAttendanceExcel(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: AttendanceExportQueryDto,
  ) {
    return this.exportsService.exportAttendance(
      user.sub,
      user.organizationId!,
      user.role,
      { ...query, format: 'xlsx' } as any,
      res,
      req.headers['x-request-id'] as string,
    );
  }

  // ── GET /reports/analytics ─────────────────────────────────────────────────
  // Flutter: String get analyticsSummary => '/reports/analytics'
  // Returns admin operational analytics (attendance + meal KPIs).

  @Get('analytics')
  async getAnalytics(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.dashboardService.getAdminDashboard(
      user.sub,
      user.organizationId!,
      user.role,
    );
  }

  // ── GET /reports/meals ─────────────────────────────────────────────────────
  // Flutter: String get mealAnalytics => '/reports/meals'
  // Returns meal-level preference analytics for the org.
  //
  // If groupId is provided  → per-group attendance analytics (slot/daily breakdown).
  // If groupId is omitted   → org-level admin dashboard (avoids empty-groupId query).

  @Get('meals')
  async getMealAnalytics(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    if (groupId) {
      return this.dashboardService.getAttendanceAnalytics(
        user.organizationId!,
        user.role,
        groupId,
        fromDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        toDate ?? new Date().toISOString().slice(0, 10),
      );
    }
    // No groupId — fall back to org-level admin dashboard summary
    return this.dashboardService.getAdminDashboard(
      user.sub,
      user.organizationId!,
      user.role,
    );
  }
}
