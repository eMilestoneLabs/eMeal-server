import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  Roles,
  ALL_ADMIN_ROLES,
} from '../../common/decorators/roles.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { RetentionService } from './retention.service';

/**
 * RetentionController — Reports → Data Archives (RPT-010 step 4).
 *
 * Admins download the pre-purge Excel/PDF archives from here at any time;
 * download is never a purge precondition. organizationId always from JWT.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ALL_ADMIN_ROLES)
@Controller('retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('archives')
  async listArchives(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId?: string,
  ) {
    return this.retention.listArchives(user.organizationId!, groupId);
  }
}
