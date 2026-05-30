import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { Roles, ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { SchedulesService } from './schedules.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto, CloneScheduleDto } from './dto/update-schedule.dto';
import { QuerySchedulesDto } from './dto/query-meals.dto';

/**
 * SchedulesController
 *
 * Routes:
 *   POST   /api/v1/schedules                    — create draft schedule (admin)
 *   GET    /api/v1/schedules                    — list schedules for group
 *   GET    /api/v1/schedules/:id                — get schedule with entries
 *   PATCH  /api/v1/schedules/:id                — update draft schedule (admin)
 *   POST   /api/v1/schedules/:id/publish        — publish schedule (admin)
 *   POST   /api/v1/schedules/:id/clone          — clone to new week (admin)
 *
 * Publishing lifecycle:
 *   draft → published (admin publishes) → visible to students
 *   Cannot edit a published schedule. Clone creates a new draft.
 *
 * weekStartDate is always serialized as "YYYY-MM-DD" date-only string.
 * entries[].day is always serialized as "monday"..."sunday" string.
 */
@UseGuards(JwtAuthGuard)
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  // ── CREATE ────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async createSchedule(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateScheduleDto,
    @Req() req: Request,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException({
        message: 'No organization',
        errors: { organizationId: 'Admin must belong to an organization' },
      });
    }
    return this.schedulesService.createSchedule(
      user.sub,
      user.organizationId,
      dto,
      req.requestId,
    );
  }

  // ── LIST ──────────────────────────────────────────────────────────────────

  @Get()
  async getSchedules(
    @CurrentUser() user: JwtPayload,
    @Query() query: QuerySchedulesDto,
  ) {
    if (!user.organizationId) {
      return { data: [], total: 0, page: 1, limit: 20 };
    }
    return this.schedulesService.getSchedules(
      user.sub,
      user.role,
      user.organizationId,
      query,
    );
  }

  // ── GET ONE ───────────────────────────────────────────────────────────────

  @Get(':id')
  async getScheduleById(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException({
        message: 'No organization',
        errors: { organizationId: 'User has no organization' },
      });
    }
    return this.schedulesService.getScheduleById(id, user.organizationId, user.role);
  }

  // ── UPDATE (draft only) ───────────────────────────────────────────────────

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async updateSchedule(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateScheduleDto,
    @Req() req: Request,
  ) {
    return this.schedulesService.updateSchedule(
      id,
      user.organizationId!,
      user.sub,
      dto,
      req.requestId,
    );
  }

  // ── PUBLISH ───────────────────────────────────────────────────────────────

  /**
   * POST /schedules/:id/publish — MUST be before /:id/clone to avoid collision.
   * Idempotent: publishing an already-published schedule returns the schedule.
   */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async publishSchedule(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.schedulesService.publishSchedule(
      id,
      user.organizationId!,
      user.sub,
      req.requestId,
    );
  }

  // ── CLONE ─────────────────────────────────────────────────────────────────

  @Post(':id/clone')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async cloneSchedule(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CloneScheduleDto,
    @Req() req: Request,
  ) {
    return this.schedulesService.cloneSchedule(
      id,
      user.organizationId!,
      user.sub,
      dto,
      req.requestId,
    );
  }
}
