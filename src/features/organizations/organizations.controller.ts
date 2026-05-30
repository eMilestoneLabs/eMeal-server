import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

/**
 * OrganizationsController
 *
 * Routes:
 *   POST  /api/v1/organizations       — create org (admin roles)
 *   GET   /api/v1/organizations/me    — get own org
 *   PATCH /api/v1/organizations/me    — update own org (admin roles)
 *
 * Organization isolation: organizationId always derived from JWT, never client payload.
 */
@UseGuards(JwtAuthGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  /**
   * POST /api/v1/organizations
   * Creates a new organization for admin users who don't yet have one.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrganization(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOrganizationDto,
    @Req() req: Request,
  ) {
    return this.organizationsService.createOrganization(
      user.sub,
      user.role,
      user.organizationId,
      dto,
      req.requestId,
    );
  }

  /**
   * GET /api/v1/organizations/me
   * Returns the current user's organization.
   * organizationId comes exclusively from JWT — never from client.
   */
  @Get('me')
  async getMyOrganization(@CurrentUser() user: JwtPayload) {
    return this.organizationsService.getMyOrganization(user.organizationId);
  }

  /**
   * PATCH /api/v1/organizations/me
   * Update current org settings (name, slug, timezone, logo).
   * Requires admin role in JWT.
   */
  @Patch('me')
  @HttpCode(HttpStatus.OK)
  async updateMyOrganization(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateOrganizationDto,
    @Req() req: Request,
  ) {
    return this.organizationsService.updateMyOrganization(
      user.sub,
      user.role,
      user.organizationId,
      dto,
      req.requestId,
    );
  }
}
