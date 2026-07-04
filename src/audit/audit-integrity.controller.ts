import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditService } from './audit.service';

/**
 * Pass 14 (FR-DLC-006) — GET /api/v1/admin/audit/integrity?limit=500
 *
 * Recomputes the HMAC of the org's most recent audit rows and reports any
 * tampering evidence. Read-only, admin-only, org-scoped from JWT.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('hostelAdmin', 'organizationManager', 'hostelManager', 'messManager')
@Controller('admin/audit')
export class AuditIntegrityController {
  constructor(private readonly audit: AuditService) {}

  @Get('integrity')
  async integrity(
    @CurrentUser() user: { organizationId: string },
    @Query('limit') limit?: string,
  ) {
    const n = limit ? parseInt(limit, 10) : 500;
    return this.audit.verifyIntegrity(
      user.organizationId!,
      Number.isFinite(n) ? n : 500,
    );
  }
}
