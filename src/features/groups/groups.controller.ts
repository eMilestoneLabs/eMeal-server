import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { Roles, ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { GroupsService } from './groups.service';
import { CreateGroupDto, MealConfigDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { JoinGroupDto } from './dto/join-group.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { QueryGroupsDto, QueryMembersDto } from './dto/query-groups.dto';

/**
 * GroupsController
 *
 * Routes:
 *   POST   /api/v1/groups                                    — create group (admin)
 *   GET    /api/v1/groups                                    — list groups
 *   POST   /api/v1/groups/join                               — join via join code
 *   GET    /api/v1/groups/:id                                — get group details
 *   PATCH  /api/v1/groups/:id                                — update group (admin)
 *   DELETE /api/v1/groups/:id                                — archive group (admin)
 *   PATCH  /api/v1/groups/:id/meal-config                    — update meal config (admin)
 *   POST   /api/v1/groups/:id/join-code/regenerate           — regen join code (admin)
 *   GET    /api/v1/groups/:id/members                        — list members
 *   PATCH  /api/v1/groups/:id/members/:memberId              — update member (admin)
 *   DELETE /api/v1/groups/:id/members/:memberId              — remove member (admin)
 *   PATCH  /api/v1/groups/:id/members/:memberId/unblock      — unblock member (admin, M-24)
 *
 * Organization isolation: organizationId always from JWT, never client payload.
 */
@UseGuards(JwtAuthGuard)
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  // ── CREATE ────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async createGroup(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateGroupDto,
    @Req() req: Request,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException({
        message: 'No organization found',
        errors: { organizationId: 'You must belong to an organization to create groups' },
      });
    }
    return this.groupsService.createGroup(user.organizationId, user.sub, dto, req.requestId);
  }

  // ── LIST ──────────────────────────────────────────────────────────────────

  @Get()
  async getGroups(@CurrentUser() user: JwtPayload, @Query() query: QueryGroupsDto) {
    if (!user.organizationId) return { data: [], total: 0, page: 1, limit: 20 };
    return this.groupsService.getGroups(user.sub, user.role, user.organizationId, query);
  }

  // ── JOIN (must be before /:id routes) ────────────────────────────────────

  @Post('join')
  @HttpCode(HttpStatus.OK)
  async joinGroup(@CurrentUser() user: JwtPayload, @Body() dto: JoinGroupDto, @Req() req: Request) {
    return this.groupsService.joinGroup(user.sub, dto, req.requestId);
  }

  // ── GET ONE ───────────────────────────────────────────────────────────────

  @Get(':id')
  async getGroupById(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.organizationId) {
      throw new BadRequestException({
        message: 'No organization',
        errors: { organizationId: 'User has no organization' },
      });
    }
    return this.groupsService.getGroupById(id, user.organizationId, user.sub, user.role);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async updateGroup(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateGroupDto,
    @Req() req: Request,
  ) {
    return this.groupsService.updateGroup(id, user.organizationId!, user.sub, dto, req.requestId);
  }

  // ── DELETE (soft) ─────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async deleteGroup(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Req() req: Request) {
    return this.groupsService.deleteGroup(id, user.organizationId!, user.sub, req.requestId);
  }

  // ── MEAL CONFIG ───────────────────────────────────────────────────────────

  @Patch(':id/meal-config')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async updateMealConfig(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: MealConfigDto,
    @Req() req: Request,
  ) {
    return this.groupsService.updateGroup(id, user.organizationId!, user.sub, { mealConfig: dto }, req.requestId);
  }

  // ── JOIN CODE REGENERATION ────────────────────────────────────────────────

  @Post(':id/join-code/regenerate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async regenerateJoinCode(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Query('expiresInHours') expiresInHours?: string,
  ) {
    const hours = expiresInHours ? parseInt(expiresInHours, 10) : undefined;
    return this.groupsService.regenerateJoinCode(id, user.organizationId!, user.sub, hours, req.requestId);
  }

  // ── MEMBERS ───────────────────────────────────────────────────────────────

  // ── POST /groups/:id/members — Flutter: addMember = '/groups/{groupId}/members' ──
  // Admin adds a user by userId to the group directly (without QR scan)

  @Post(':id/members')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async addMember(
    @Param('id') groupId: string,
    @CurrentUser() user: JwtPayload,
    @Body() body: { userId: string; role?: string },
    @Req() req: Request,
  ) {
    if (!user.organizationId) {
      throw new BadRequestException({ message: 'No organization', errors: { organizationId: 'Required' } });
    }
    return this.groupsService.addMemberById(groupId, user.organizationId!, user.sub, body.userId, body.role, req.requestId);
  }

  @Get(':id/members')
  async getMembers(
    @Param('id') groupId: string,
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryMembersDto,
  ) {
    if (!user.organizationId) return { data: [], total: 0, page: 1, limit: 20 };
    return this.groupsService.getMembers(groupId, user.organizationId, user.sub, user.role, query);
  }

  @Patch(':id/members/:memberId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async updateMember(
    @Param('id') groupId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateMemberDto,
    @Req() req: Request,
  ) {
    return this.groupsService.updateMember(groupId, memberId, user.organizationId!, user.sub, dto, req.requestId);
  }

  @Delete(':id/members/:memberId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async removeMember(
    @Param('id') groupId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.groupsService.removeMember(groupId, memberId, user.organizationId!, user.sub, req.requestId);
  }

  /**
   * M-24: PATCH /groups/:id/members/:memberId/unblock
   * Unblock a previously blocked member — restores status to 'active'.
   * Dedicated endpoint required per Flutter contract.
   */
  @Patch(':id/members/:memberId/unblock')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async unblockMember(
    @Param('id') groupId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    return this.groupsService.updateMember(
      groupId,
      memberId,
      user.organizationId!,
      user.sub,
      { status: 'active' },
      req.requestId,
    );
  }
  // ── GET /groups/:id/qr-token — Flutter: qrToken = '/groups/{groupId}/qr-token' ──
  // Returns the current joinCode for the group (admin only).
  // Flutter uses this to render the QR code with the join token.

  @Get(':id/qr-token')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async getQrToken(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.groupsService.getQrToken(id, user.organizationId!);
  }

  // ── GET /groups/:id/meal-config — Flutter: mealConfig = '/groups/{groupId}/meal-config' ─

  @Get(':id/meal-config')
  async getMealConfig(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.groupsService.getMealConfig(id, user.organizationId!);
  }

  // ── PUT /groups/:id/meal-config — Flutter: updateMealConfig ───────────────
  // Flutter sends PUT but backend has PATCH — add PUT alias.

  @Put(':id/meal-config')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async putMealConfig(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: any,
    @Req() req: Request,
  ) {
    return this.groupsService.updateGroup(id, user.organizationId!, user.sub, { mealConfig: dto }, req.requestId);
  }

}
