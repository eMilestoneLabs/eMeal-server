import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { Roles, ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { CorrectionsService } from './corrections.service';
import { CreateCorrectionRequestDto } from './dto/create-correction-request.dto';
import { QueryCorrectionRequestDto } from './dto/query-correction-request.dto';
import { ReviewCorrectionRequestDto } from './dto/review-correction-request.dto';

/**
 * CorrectionsController — Module 33 Attendance Correction Requests.
 *
 *   POST /api/v1/attendance/correction-requests              — create (member, FR-ACR-001)
 *   GET  /api/v1/attendance/correction-requests              — list (admin: queue · member: own)
 *   POST /api/v1/attendance/correction-requests/:id/approve  — approve (admin, FR-ACR-010)
 *   POST /api/v1/attendance/correction-requests/:id/reject   — reject  (admin, FR-ACR-010)
 *   POST /api/v1/attendance/correction-requests/:id/cancel   — cancel  (owner, FR-ACR-011)
 *   POST /api/v1/attendance/correction-requests/:id/confirm  — confirm admin prompt (owner, FR-OVR-020)
 *   POST /api/v1/attendance/correction-requests/:id/decline  — decline admin prompt (owner, FR-OVR-020)
 */
@UseGuards(JwtAuthGuard)
@Controller('attendance/correction-requests')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateCorrectionRequestDto,
    @Req() req: Request,
  ) {
    return this.corrections.createRequest(
      user.sub,
      user.organizationId!,
      dto,
      req.requestId,
    );
  }

  @Get()
  async list(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryCorrectionRequestDto,
  ) {
    if (!user.organizationId) {
      return { data: [], total: 0, page: 1, limit: 20 };
    }
    return this.corrections.listRequests(
      user.sub,
      user.role,
      user.organizationId,
      query,
    );
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async approve(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReviewCorrectionRequestDto,
    @Req() req: Request,
  ) {
    return this.corrections.approve(
      user.sub,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReviewCorrectionRequestDto,
    @Req() req: Request,
  ) {
    return this.corrections.reject(
      user.sub,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReviewCorrectionRequestDto,
    @Req() req: Request,
  ) {
    return this.corrections.cancel(
      user.sub,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.corrections.confirm(
      user.sub,
      user.organizationId!,
      id,
      req.requestId,
    );
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  async decline(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReviewCorrectionRequestDto,
    @Req() req: Request,
  ) {
    return this.corrections.decline(
      user.sub,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }
}
