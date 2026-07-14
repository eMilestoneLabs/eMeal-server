import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
  Req,
  Headers,
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
    // UNI-036: optional Idempotency-Key header — retry-safe financial posts.
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.billingService.createAdjustment(
      user.sub, user.organizationId!, dto, req.requestId, idempotencyKey,
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

/**
 * BillingMemberController — command_6 (survey 2026-07-13): the member side of
 * the debit-approval workflow. JWT only, deliberately NO role gate: the
 * service verifies the caller IS the billed member (self-consent), and the
 * pending list is self-scoped. Admin routes stay in BillingController above.
 *
 *   GET  /billing/adjustments/my-pending    — my debits awaiting my approval
 *   POST /billing/adjustments/:id/approve   — approve (posts to my bill)
 *   POST /billing/adjustments/:id/reject    — decline (never billed)
 */
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingMemberController {
  constructor(private readonly billingService: BillingService) {}

  @Get('adjustments/my-pending')
  async myPendingAdjustments(
    @CurrentUser() user: { sub: string; organizationId: string },
  ) {
    return this.billingService.listMyPendingAdjustments(
      user.organizationId!, user.sub,
    );
  }

  @Post('adjustments/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approveAdjustment(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.billingService.decideAdjustment(
      user.sub, user.organizationId!, id, 'approved', req.requestId,
    );
  }

  @Post('adjustments/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectAdjustment(
    @CurrentUser() user: { sub: string; organizationId: string },
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.billingService.decideAdjustment(
      user.sub, user.organizationId!, id, 'rejected', req.requestId,
    );
  }
}
