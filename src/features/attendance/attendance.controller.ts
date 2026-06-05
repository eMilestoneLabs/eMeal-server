import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Query,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
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
 * AttendanceController
 *
 * Route map (Flutter api_endpoints.dart contract):
 *   POST   /attendance                    — mark attendance (Flutter: mark)
 *   POST   /attendance/bulk               — bulk mark
 *   POST   /attendance/admin/override     — admin override
 *   GET    /attendance                    — paginated history (Flutter: list)
 *   GET    /attendance/today              — today's records (Flutter: todaySummary)
 *   GET    /attendance/history            — paginated history alias (Flutter: history)
 *   GET    /attendance/summary            — aggregate counts
 *   GET    /attendance/weekly-summary     — last 7-day summary (Flutter: weeklySummary)
 *   GET    /attendance/meal-summary       — per-meal aggregate (admin)
 *   PATCH  /attendance/:id               — update existing record (Flutter: update)
 *
 * ORDERING: named sub-routes MUST come BEFORE /:id routes.
 */
@UseGuards(JwtAuthGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // ── POST /attendance ───────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.OK)
  async markAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Body() dto: MarkAttendanceDto,
    @Req() req: any,
  ) {
    return this.attendanceService.markAttendance(
      user.sub, user.organizationId!, dto, req.requestId,
    );
  }

  // ── POST /attendance/bulk ──────────────────────────────────────────────────

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  async bulkMarkAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Body() dto: BulkAttendanceDto,
    @Req() req: any,
  ) {
    return this.attendanceService.bulkMarkAttendance(
      user.sub, user.organizationId!, dto, req.requestId,
    );
  }

  // ── POST /attendance/admin/override — MUST be before /:id ─────────────────

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
      user.sub, user.organizationId!, dto, req.requestId,
    );
  }

  // ── GET /attendance/today — Flutter: todaySummary = '/attendance/today' ────
  // Returns today's attendance records for the current user.

  @Get('today')
  async getTodayAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query('groupId') groupId?: string,
  ) {
    const today = new Date().toISOString().slice(0, 10);
    return this.attendanceService.getAttendance(
      user.sub,
      user.role,
      user.organizationId!,
      { fromDate: today, toDate: today, groupId, page: 1, limit: 50 } as any,
    );
  }

  // ── GET /attendance/history — Flutter: history = '/attendance/history' ─────
  // Paginated attendance history — alias for GET /attendance.

  @Get('history')
  async getAttendanceHistory(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query() query: QueryAttendanceDto,
  ) {
    return this.attendanceService.getAttendance(
      user.sub, user.role, user.organizationId!, query,
    );
  }

  // ── GET /attendance/weekly-summary — Flutter: weeklySummary ───────────────
  // Returns summary for the last 7 days.

  @Get('weekly-summary')
  async getWeeklySummary(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query('groupId') groupId?: string,
    @Query('userId') userId?: string,
  ) {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    return this.attendanceService.getUserSummary(
      user.sub,
      user.role,
      user.organizationId!,
      {
        groupId,
        userId: userId || user.sub,
        fromDate: from.toISOString().slice(0, 10),
        toDate: to.toISOString().slice(0, 10),
      } as any,
    );
  }

  // ── GET /attendance/summary — aggregate counts ─────────────────────────────
  // MUST be before /:id

  @Get('summary')
  async getUserSummary(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query() query: QuerySummaryDto,
  ) {
    return this.attendanceService.getUserSummary(
      user.sub, user.role, user.organizationId!, query,
    );
  }

  // ── GET /attendance/meal-summary (admin) — MUST be before /:id ────────────

  @Get('meal-summary')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async getMealSummary(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query() query: QueryMealSummaryDto,
  ) {
    return this.attendanceService.getMealSummary(user.organizationId!, query);
  }

  // ── GET /attendance — paginated history (Flutter: list = '/attendance') ────

  @Get()
  async getAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Query() query: QueryAttendanceDto,
  ) {
    return this.attendanceService.getAttendance(
      user.sub, user.role, user.organizationId!, query,
    );
  }

  // ── PATCH /attendance/:id — Flutter: update = '/attendance/{attendanceId}' ─
  // MUST come after all named sub-routes.

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async updateAttendance(
    @CurrentUser() user: { sub: string; organizationId: string; role: string },
    @Param('id') id: string,
    @Body() dto: MarkAttendanceDto,
    @Req() req: any,
  ) {
    // Reuse markAttendance — it is idempotent (upserts by userId+mealId+date).
    // Pass the record id via dto for targeted update.
    return this.attendanceService.markAttendance(
      user.sub,
      user.organizationId!,
      { ...dto, attendanceId: id } as any,
      req.requestId,
    );
  }
}
