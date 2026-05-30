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
import { QueryMealsDto } from './dto/query-meals.dto';

/**
 * MealsController
 *
 * Routes:
 *   POST   /api/v1/meals                   — create meal slot (admin)
 *   GET    /api/v1/meals                   — list meals for group
 *   PATCH  /api/v1/meals/reorder           — reorder meals (admin) [BEFORE /:id]
 *   GET    /api/v1/meals/:id               — get meal details
 *   PATCH  /api/v1/meals/:id               — update meal (admin)
 *   DELETE /api/v1/meals/:id               — archive meal (admin)
 *
 * Dynamic rendering:
 *   - slotKey is free-form string — never an enum
 *   - isEnabled controls student visibility
 *   - attendanceEnabled is independent — attendance can remain while meal is hidden
 *   - attendanceWindow always serialized as nested { openTime, closeTime }
 */
@UseGuards(JwtAuthGuard)
@Controller('meals')
export class MealsController {
  constructor(private readonly mealsService: MealsService) {}

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

  // ── REORDER (MUST be before /:id to prevent route collision) ─────────────

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

  // ── GET ONE ───────────────────────────────────────────────────────────────

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
