import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  FinalizePeriodDto,
  ReopenPeriodDto,
  QueryPeriodsDto,
} from './dto/billing-period.dto';
import {
  CreateAdjustmentDto,
  QueryAdjustmentsDto,
} from './dto/billing-adjustment.dto';

const ADMIN_ROLES = [
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
] as const;

/**
 * BillingController — SRS FR-DISP-010 (Pass 7).
 *
 * Route map (additive; the legacy billing reads stay under /attendance):
 *   POST /billing/periods              — finalize (lock) a period
 *   GET  /billing/periods?groupId=     — list periods
 *   POST /billing/periods/:id/reopen   — controlled reopen (reason mandatory)
 *   POST /billing/periods/:id/finalize — re-lock a reopened period
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('periods')
  @HttpCode(HttpStatus.OK)
  async finalizePeriod(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Body() dto: FinalizePeriodDto,
    @Req() req: any,
  ) {
    return this.billingService.finalizePeriod(
      user.sub, user.organizationId!, dto, req.requestId,
    );
  }

  @Get('periods')
  async listPeriods(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Query() query: QueryPeriodsDto,
  ) {
    return this.billingService.listPeriods(user.organizationId!, query.groupId);
  }

  // ── Pass 12 (FR-BILLX-030/031): append-only adjustments ──────────────────

  @Post('adjustments')
  @HttpCode(HttpStatus.CREATED)
  async createAdjustment(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Body() dto: CreateAdjustmentDto,
    @Req() req: any,
  ) {
    return this.billingService.createAdjustment(
      user.sub, user.organizationId!, dto, req.requestId,
    );
  }

  @Get('adjustments')
  async listAdjustments(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Query() query: QueryAdjustmentsDto,
  ) {
    return this.billingService.listAdjustments(user.organizationId!, query);
  }

  @Post('periods/:id/reopen')
  @HttpCode(HttpStatus.OK)
  async reopenPeriod(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Param('id') id: string,
    @Body() dto: ReopenPeriodDto,
    @Req() req: any,
  ) {
    return this.billingService.reopenPeriod(
      user.sub, user.organizationId!, id, dto, req.requestId,
    );
  }

  @Post('periods/:id/finalize')
  @HttpCode(HttpStatus.OK)
  async refinalizePeriod(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.billingService.refinalizePeriod(
      user.sub, user.organizationId!, id, req.requestId,
    );
  }
}
