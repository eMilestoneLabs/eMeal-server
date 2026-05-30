import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { BulkAttendanceDto } from './dto/bulk-attendance.dto';
import { AdminOverrideDto } from './dto/admin-override.dto';
import {
  QueryAttendanceDto,
  QuerySummaryDto,
  QueryMealSummaryDto,
} from './dto/query-attendance.dto';

const ADMIN_ROLES = [
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
] as const;

/**
 * AttendanceController — 7 HTTP endpoints.
 *
 * Route map:
 *   POST /attendance                  — student marks own attendance
 *   POST /attendance/bulk             — student marks multiple meals at once
 *   POST /attendance/admin/override   — admin marks attendance for any user
 *   GET  /attendance                  — paginated history (student: own; admin: group)
 *   GET  /attendance/summary          — aggregate counts (no rates)
 *   GET  /attendance/meal-summary     — per-meal aggregate (admin only)
 *
 * Note: /attendance/admin/override and /attendance/meal-summary must be
 * declared BEFORE any /:id-style routes to prevent NestJS route collision.
 */
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // ── POST /attendance — student marks own attendance ────────────────────────

  @Post()
  @HttpCode(HttpStatus.OK)
  async markAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Body() dto: MarkAttendanceDto,
    @Req() req: any,
  ) {
    return this.attendanceService.markAttendance(
      user.sub,
      user.organizationId!,
      dto,
      req.requestId,
    );
  }

  // ── POST /attendance/bulk — student marks multiple meals ───────────────────

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  async bulkMarkAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Body() dto: BulkAttendanceDto,
    @Req() req: any,
  ) {
    return this.attendanceService.bulkMarkAttendance(
      user.sub,
      user.organizationId!,
      dto,
      req.requestId,
    );
  }

  // ── POST /attendance/admin/override — admin override ──────────────────────
  // MUST be declared before /:id routes

  @Post('admin/override')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async adminOverride(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Body() dto: AdminOverrideDto,
    @Req() req: any,
  ) {
    return this.attendanceService.adminOverride(
      user.sub,
      user.organizationId!,
      dto,
      req.requestId,
    );
  }

  // ── GET /attendance — paginated history ────────────────────────────────────

  @Get()
  async getAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query() query: QueryAttendanceDto,
  ) {
    return this.attendanceService.getAttendance(
      user.sub,
      user.role,
      user.organizationId!,
      query,
    );
  }

  // ── GET /attendance/summary — aggregate counts ─────────────────────────────
  // MUST be declared before potential /:id style routes

  @Get('summary')
  async getUserSummary(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query() query: QuerySummaryDto,
  ) {
    return this.attendanceService.getUserSummary(
      user.sub,
      user.role,
      user.organizationId!,
      query,
    );
  }

  // ── GET /attendance/meal-summary — per-meal aggregate (admin) ─────────────

  @Get('meal-summary')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async getMealSummary(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query() query: QueryMealSummaryDto,
  ) {
    return this.attendanceService.getMealSummary(
      user.organizationId!,
      query,
    );
  }
}
