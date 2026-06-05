import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
import { MealsService } from './meals.service';
import { CreateMealDto } from './dto/create-meal.dto';
import { UpdateMealDto, ReorderMealsDto } from './dto/update-meal.dto';
import { QueryMealsDto, QuerySchedulesDto } from './dto/query-meals.dto';
import { SchedulesService } from './schedules.service';

/**
 * MealsController
 *
 * Routes — ORDER MATTERS in NestJS (Express under the hood):
 * Named/literal sub-routes MUST be declared BEFORE /:id routes.
 *
 *   POST   /api/v1/meals                    — create meal slot (admin)
 *   GET    /api/v1/meals                    — list meals for group
 *   PATCH  /api/v1/meals/reorder            — reorder meals (admin) [BEFORE /:id]
 *   GET    /api/v1/meals/today              — today's active meals [BEFORE /:id]
 *   GET    /api/v1/meals/weekly-schedule    — Flutter contract alias [BEFORE /:id]
 *   POST   /api/v1/meals/weekly-schedule    — Flutter contract alias [BEFORE /:id]
 *   POST   /api/v1/meals/:id/image          — upload meal image stub
 *   GET    /api/v1/meals/:id               — get meal details
 *   PATCH  /api/v1/meals/:id               — update meal (admin)
 *   DELETE /api/v1/meals/:id               — archive meal (admin)
 *
 * Dynamic rendering:
 *   - slotKey is free-form string — never an enum
 *   - isActive controls student visibility
 *   - attendanceEnabled is independent — attendance can remain while meal is hidden
 *   - attendanceWindow always serialized as nested { openTime, closeTime }
 *
 * BUG-003 FIX (2026-06-01):
 *   weekly-schedule routes were declared AFTER :id routes — NestJS matched
 *   GET /meals/weekly-schedule as GET /meals/:id with id='weekly-schedule'.
 *   Fixed by moving all named sub-routes before /:id declarations.
 */
@UseGuards(JwtAuthGuard)
@Controller('meals')
export class MealsController {
  constructor(
    private readonly mealsService: MealsService,
    private readonly schedulesService: SchedulesService,
  ) {}

  // ── CREATE ────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async createMeal(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateMealDto,
    @Req() req: Request,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException({
        message: 'No organization',
        errors: { organizationId: 'Admin must belong to an organization' },
      });
    }
    return this.mealsService.createMeal(
      user.sub,
      user.organizationId,
      dto,
      req.requestId,
    );
  }

  // ── LIST ──────────────────────────────────────────────────────────────────

  @Get()
  async getMeals(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryMealsDto,
  ) {
    if (!user.organizationId) {
      return { data: [], total: 0, page: 1, limit: 20 };
    }
    return this.mealsService.getMeals(
      user.sub,
      user.role,
      user.organizationId,
      query,
    );
  }

  // ── REORDER — MUST be before /:id ─────────────────────────────────────────

  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async reorderMeals(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ReorderMealsDto,
    @Req() req: Request,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException({
        message: 'No organization',
        errors: { organizationId: 'Admin must belong to an organization' },
      });
    }
    return this.mealsService.reorderMeals(
      user.organizationId,
      user.sub,
      dto,
      req.requestId,
    );
  }

  // ── GET /meals/today — MUST be before /:id ────────────────────────────────
  // Flutter: String get today => '/meals/today'

  @Get('today')
  async getTodayMeals(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId?: string,
  ) {
    if (!user.organizationId || !groupId) {
      return { data: [], total: 0, page: 1, limit: 20 };
    }
    return this.mealsService.getMeals(
      user.sub,
      user.role,
      user.organizationId,
      { groupId, isActive: true, page: 1, limit: 50 } as QueryMealsDto,
    );
  }

  // ── GET /meals/weekly-schedule — MUST be before /:id ─────────────────────
  // Flutter: String get weeklySchedule => '/meals/weekly-schedule'
  // BUG-003 FIX: was declared AFTER /:id, so it was matched as /:id.

  @Get('weekly-schedule')
  async getWeeklySchedule(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId: string,
    @Query('weekStart') weekStart?: string,
  ) {
    if (!groupId) {
      return { data: [], total: 0, page: 1, limit: 10 };
    }
    return this.schedulesService.getSchedules(
      user.organizationId!,
      groupId,
      user.role,
      user.sub,
      { groupId, page: 1, limit: 1 } as QuerySchedulesDto,
    );
  }

  // ── POST /meals/weekly-schedule — MUST be before /:id ────────────────────
  // Flutter: String get updateWeeklySchedule => '/meals/weekly-schedule'

  @Post('weekly-schedule')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async createWeeklySchedule(
    @CurrentUser() user: JwtPayload,
    @Body() body: any,
    @Req() req: Request,
  ) {
    return this.schedulesService.createSchedule(
      user.organizationId!,
      user.sub,
      body,
      req.requestId,
    );
  }

  // ── POST /meals/:id/image — MUST be before GET /:id ───────────────────────
  // Flutter: String get uploadImage => '/meals/{mealId}/image'
  // Stub endpoint — image upload via multipart. Full R2 impl in B11.

  @Post(':id/image')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  @HttpCode(HttpStatus.OK)
  async uploadMealImage(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    // Stub: return placeholder. Real implementation will upload to Cloudflare R2.
    return {
      imageUrl: null,
      message: 'Image upload endpoint ready. R2 integration pending in B11.',
    };
  }

  // ── GET ONE — declared AFTER all named sub-routes ─────────────────────────

  @Get(':id')
  async getMealById(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Query('includeDisabled') includeDisabled?: string,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException({
        message: 'No organization',
        errors: { organizationId: 'User has no organization' },
      });
    }
    return this.mealsService.getMealById(
      id,
      user.organizationId,
      user.role,
      includeDisabled === 'true',
    );
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async updateMeal(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateMealDto,
    @Req() req: Request,
  ) {
    return this.mealsService.updateMeal(
      id,
      user.organizationId!,
      user.sub,
      dto,
      req.requestId,
    );
  }

  // ── DELETE (soft) ─────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async deleteMeal(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.mealsService.deleteMeal(
      id,
      user.organizationId!,
      user.sub,
      req.requestId,
    );
  }
}
