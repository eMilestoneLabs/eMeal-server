/**
 * preferences.controller.ts — Module 36 (FR-PG-090)
 *
 * Routes (all /api/v1, org-isolated from JWT, audited):
 *   GET    /meals/:mealId/preference-groups          — effective groups (member+admin)
 *   POST   /meals/:mealId/preference-groups          — create/bind group      (admin)
 *   DELETE /meals/:mealId/preference-groups/:id      — unbind from meal       (admin)
 *   PATCH  /preference-groups/:id                    — update group           (admin)
 *   DELETE /preference-groups/:id                    — soft deactivate        (admin)
 *   POST   /preference-groups/:id/options            — add option             (admin)
 *   PATCH  /preference-options/:id                   — update option          (admin)
 *   DELETE /preference-options/:id                   — soft deactivate        (admin)
 *   GET    /groups/:groupId/preference-templates     — reusable templates     (admin)
 *   POST   /groups/:groupId/preference-templates     — create template        (admin)
 *   GET    /groups/:groupId/preference-crosstab      — kitchen cross-tab      (admin)
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { PreferencesService } from './preferences.service';
import {
  CreatePreferenceGroupDto,
  UpdatePreferenceGroupDto,
  PreferenceOptionDto,
  UpdatePreferenceOptionDto,
} from './dto/preference-group.dto';

@UseGuards(JwtAuthGuard)
@Controller()
export class PreferencesController {
  constructor(private readonly service: PreferencesService) {}

  private orgOf(user: JwtPayload): string {
    if (!user.organizationId) {
      throw new ForbiddenException('No organization context');
    }
    return user.organizationId;
  }

  // ── Effective read (member + admin) ────────────────────────────────────────

  @Get('meals/:mealId/preference-groups')
  listForMeal(@CurrentUser() user: JwtPayload, @Param('mealId') mealId: string) {
    return this.service.listForMeal(mealId, this.orgOf(user));
  }

  // ── Meal-scoped config (admin) ─────────────────────────────────────────────

  @Post('meals/:mealId/preference-groups')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  createForMeal(
    @CurrentUser() user: JwtPayload,
    @Param('mealId') mealId: string,
    @Body() dto: CreatePreferenceGroupDto,
    @Req() req: Request,
  ) {
    return this.service.createForMeal(
      user.sub,
      this.orgOf(user),
      mealId,
      dto,
      req.requestId,
    );
  }

  @Delete('meals/:mealId/preference-groups/:id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  unbindFromMeal(
    @CurrentUser() user: JwtPayload,
    @Param('mealId') mealId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.service.unbindFromMeal(
      user.sub,
      this.orgOf(user),
      mealId,
      id,
      req.requestId,
    );
  }

  // ── Group + option config (admin) ──────────────────────────────────────────

  @Patch('preference-groups/:id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  updateGroup(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdatePreferenceGroupDto,
    @Req() req: Request,
  ) {
    return this.service.updateGroup(user.sub, this.orgOf(user), id, dto, req.requestId);
  }

  @Delete('preference-groups/:id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  deactivateGroup(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.service.deactivateGroup(user.sub, this.orgOf(user), id, req.requestId);
  }

  @Post('preference-groups/:id/options')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  addOption(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PreferenceOptionDto,
    @Req() req: Request,
  ) {
    return this.service.addOption(user.sub, this.orgOf(user), id, dto, req.requestId);
  }

  @Patch('preference-options/:id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  updateOption(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdatePreferenceOptionDto,
    @Req() req: Request,
  ) {
    return this.service.updateOption(user.sub, this.orgOf(user), id, dto, req.requestId);
  }

  @Delete('preference-options/:id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  deactivateOption(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.service.deactivateOption(user.sub, this.orgOf(user), id, req.requestId);
  }

  // ── Templates + analytics (admin) ──────────────────────────────────────────

  @Get('groups/:groupId/preference-templates')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  listTemplates(@CurrentUser() user: JwtPayload, @Param('groupId') groupId: string) {
    return this.service.listTemplates(this.orgOf(user), groupId);
  }

  @Post('groups/:groupId/preference-templates')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  createTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('groupId') groupId: string,
    @Body() dto: CreatePreferenceGroupDto,
    @Req() req: Request,
  ) {
    return this.service.createTemplate(
      user.sub,
      this.orgOf(user),
      groupId,
      dto,
      req.requestId,
    );
  }

  /** FR-PG-050/051: per-group-per-option counts for the kitchen sheet. */
  @Get('groups/:groupId/preference-crosstab')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  crossTab(
    @CurrentUser() user: JwtPayload,
    @Param('groupId') groupId: string,
    @Query('date') date: string,
    @Query('mealId') mealId?: string,
  ) {
    return this.service.getCrossTab(this.orgOf(user), groupId, date, mealId);
  }
}
