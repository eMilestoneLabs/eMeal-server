import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
import { NoticesService } from './notices.service';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeDto } from './dto/update-notice.dto';
import { QueryNoticeDto } from './dto/query-notice.dto';

/**
 * NoticesController — Phase B notice board + bell center.
 *
 *   POST   /api/v1/notices              — create (admin)
 *   GET    /api/v1/notices              — list (members + admins, paginated)
 *   GET    /api/v1/notices/unread-count — unread bell badge count
 *   POST   /api/v1/notices/read-all     — mark all visible notices read
 *   POST   /api/v1/notices/:id/read     — mark one notice read
 *   PATCH  /api/v1/notices/:id          — update (admin)
 *   DELETE /api/v1/notices/:id          — soft delete (admin)
 *
 * ORDERING: static sub-routes (unread-count, read-all) precede /:id routes.
 */
@UseGuards(JwtAuthGuard)
@Controller('notices')
export class NoticesController {
  constructor(private readonly noticesService: NoticesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateNoticeDto,
    @Req() req: Request,
  ) {
    return this.noticesService.createNotice(
      user.sub,
      user.organizationId!,
      dto,
      req.requestId,
    );
  }

  @Get()
  async list(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryNoticeDto,
  ) {
    if (!user.organizationId) {
      return { data: [], total: 0, page: 1, limit: 20 };
    }
    return this.noticesService.listNotices(
      user.sub,
      user.role,
      user.organizationId,
      query,
    );
  }

  @Get('unread-count')
  async unreadCount(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId?: string,
  ) {
    if (!user.organizationId) return { count: 0 };
    return this.noticesService.getUnreadCount(
      user.sub,
      user.role,
      user.organizationId,
      groupId,
    );
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async readAll(
    @CurrentUser() user: JwtPayload,
    @Body('groupId') groupId?: string,
  ) {
    return this.noticesService.markAllRead(
      user.sub,
      user.role,
      user.organizationId!,
      groupId,
    );
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async read(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.noticesService.markRead(user.sub, user.organizationId!, id);
  }

  // ── MEMBER BELL DISMISSAL (NTF-006) — per-user, not a global delete ─────────

  /**
   * DELETE /api/v1/notices/dismiss-all — "Delete All" from the member's bell.
   * Declared before `/:id/dismiss` so the literal path wins.
   */
  @Delete('dismiss-all')
  @HttpCode(HttpStatus.OK)
  async dismissAll(
    @CurrentUser() user: JwtPayload,
    @Query('groupId') groupId?: string,
  ) {
    if (!user.organizationId) return { success: true, dismissed: 0 };
    return this.noticesService.dismissAllNotices(
      user.sub,
      user.role,
      user.organizationId,
      groupId,
    );
  }

  /**
   * DELETE /api/v1/notices/:id/dismiss — remove one notice from the member's
   * own bell (per-user hide; the shared notice is unaffected).
   */
  @Delete(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.noticesService.dismissNotice(user.sub, user.organizationId!, id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateNoticeDto,
    @Req() req: Request,
  ) {
    return this.noticesService.updateNotice(
      user.sub,
      user.organizationId!,
      id,
      dto,
      req.requestId,
    );
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.noticesService.deleteNotice(
      user.sub,
      user.organizationId!,
      id,
      req.requestId,
    );
  }
}
