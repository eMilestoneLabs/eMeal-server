import {
  Controller,
  Get,
  Post,
  Patch,
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
import { VacationsService } from './vacations.service';
import { CreateVacationRequestDto } from './dto/create-vacation-request.dto';
import { QueryVacationRequestDto } from './dto/query-vacation-request.dto';
import { ReviewVacationRequestDto } from './dto/review-vacation-request.dto';

/**
 * VacationsController — Issue 3 vacation approval workflow.
 *
 *   POST   /api/v1/vacation-requests            — create (any member)
 *   GET    /api/v1/vacation-requests            — list (admin: org; member: own)
 *   PATCH  /api/v1/vacation-requests/:id/approve — approve (admin)
 *   PATCH  /api/v1/vacation-requests/:id/reject  — reject (admin)
 *   PATCH  /api/v1/vacation-requests/:id/cancel  — cancel (owner or admin)
 */
@UseGuards(JwtAuthGuard)
@Controller('vacation-requests')
export class VacationsController {
  constructor(private readonly vacations: VacationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVacationRequestDto,
    @Req() req: Request,
  ) {
    return this.vacations.createRequest(
      user.sub,
      user.organizationId!,
      dto,
      req.requestId,
    );
  }

  @Get()
  async list(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryVacationRequestDto,
  ) {
    if (!user.organizationId) {
      return { data: [], total: 0, page: 1, limit: 20 };
    }
    return this.vacations.listRequests(
      user.sub,
      user.role,
      user.organizationId,
      query,
    );
  }

  @Patch(':id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async approve(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReviewVacationRequestDto,
    @Req() req: Request,
  ) {
    return this.vacations.approve(
      user.sub,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }

  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async reject(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReviewVacationRequestDto,
    @Req() req: Request,
  ) {
    return this.vacations.reject(
      user.sub,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }

  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ReviewVacationRequestDto,
    @Req() req: Request,
  ) {
    return this.vacations.cancel(
      user.sub,
      user.role,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }
}
