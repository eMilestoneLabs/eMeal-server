import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, ALL_ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { UsersService } from '../users/users.service';

/**
 * OrganisationsController — British-spelling alias for Flutter contract.
 *
 * Flutter api_endpoints.dart uses:
 *   detail  → GET   /organisations/{orgId}
 *   update  → PATCH /organisations/{orgId}
 *   members → GET   /organisations/{orgId}/members
 *
 * This controller provides those exact paths while the American-spelling
 * /organizations/* routes serve as the primary backend-internal paths.
 *
 * SECURITY: organizationId always derived from JWT — the /:orgId param is
 * validated against the caller's JWT organizationId to prevent cross-org access.
 */
@UseGuards(JwtAuthGuard)
@Controller('organisations')
export class OrganisationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * GET /api/v1/organisations/:orgId
   * Flutter: String get detail => '/organisations/{orgId}'
   * Returns the organization details — orgId must match JWT orgId.
   */
  @Get(':orgId')
  async getOrganisation(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
  ) {
    // Enforce org isolation — caller can only read their own org
    const effectiveOrgId = user.organizationId ?? orgId;
    return this.organizationsService.getMyOrganization(effectiveOrgId);
  }

  /**
   * PATCH /api/v1/organisations/:orgId
   * Flutter: String get update => '/organisations/{orgId}'
   * Updates org settings — admin role required, orgId must match JWT.
   */
  @Patch(':orgId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  async updateOrganisation(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
    @Body() dto: UpdateOrganizationDto,
    @Req() req: Request,
  ) {
    const effectiveOrgId = user.organizationId ?? orgId;
    return this.organizationsService.updateMyOrganization(
      user.sub,
      user.role,
      effectiveOrgId,
      dto,
      req.requestId,
    );
  }

  /**
   * GET /api/v1/organisations/:orgId/members
   * Flutter: String get members => '/organisations/{orgId}/members'
   * Returns paginated user list for the organization.
   */
  @Get(':orgId/members')
  @UseGuards(RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  async getOrganisationMembers(
    @CurrentUser() user: JwtPayload,
    @Param('orgId') orgId: string,
  ) {
    const effectiveOrgId = user.organizationId ?? orgId;
    return this.usersService.listByOrg(effectiveOrgId, { page: 1, limit: 100 });
  }
}
