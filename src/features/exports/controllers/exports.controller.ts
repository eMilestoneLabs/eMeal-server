import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Roles, ALL_ADMIN_ROLES } from '../../../common/decorators/roles.decorator';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../../common/decorators/current-user.decorator';
import { ExportsService } from '../services/exports.service';
import { AttendanceExportQueryDto, EventExportQueryDto } from '../dto/export-query.dto';

/**
 * ExportsController — B5 data export endpoints.
 *
 * Endpoints:
 *   GET /api/v1/exports/attendance   — export attendance records (CSV or XLSX)
 *   GET /api/v1/exports/event-guests — export event guest list (CSV or XLSX)
 *
 * Response: streaming binary/text — does NOT use standard JSON response wrapper.
 * Admin-only — enforced here via RolesGuard.
 * SECURITY: organizationId and userId from JWT (@CurrentUser) — NEVER from query/body.
 *
 * FIX: Replaced req.user as any → @CurrentUser() user: JwtPayload.
 *      JWT payload field is `sub`, not `userId`. user.userId was always undefined,
 *      causing audit logs to record no actorId and allow unauthenticated-style behavior.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ALL_ADMIN_ROLES)
@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get('attendance')
  async exportAttendance(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: AttendanceExportQueryDto,
  ) {
    await this.exportsService.exportAttendance(
      user.sub,            // FIX: was user.userId (undefined) — JWT payload uses `sub`
      user.organizationId!,
      user.role,
      query,
      res,
      req.headers['x-request-id'] as string,
    );
  }

  // Pass 12 (FR-BILLX-024): per-member billing rollup export.
  @Get('billing')
  async exportBilling(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: AttendanceExportQueryDto,
  ) {
    await this.exportsService.exportBilling(
      user.sub,
      user.organizationId!,
      user.role,
      query,
      res,
      req.headers['x-request-id'] as string,
    );
  }

  @Get('event-guests')
  async exportEventGuests(
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: EventExportQueryDto,
  ) {
    await this.exportsService.exportEventGuests(
      user.sub,            // FIX: was user.userId (undefined) — JWT payload uses `sub`
      user.organizationId!,
      user.role,
      query,
      res,
      req.headers['x-request-id'] as string,
    );
  }
}
