/**
 * notifications.controller.ts — B6 Phase
 *
 * Routes:
 *   POST   /api/v1/notifications/fcm-token   — register FCM push token
 *   DELETE /api/v1/notifications/fcm-token   — revoke FCM token (logout helper)
 *   GET    /api/v1/notifications/diagnostics — admin delivery diagnostics (FR-NOTX-018)
 *
 * NOTE: GET /api/v1/notifications is intentionally absent.
 * Flutter local notifications are managed client-side.
 * This controller only manages the FCM token registration lifecycle.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { RegisterFcmTokenDto } from './dto/fcm-token.dto';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * POST /api/v1/notifications/fcm-token
   * Registers or updates the FCM device token for the authenticated user.
   * Redis-deduplicated: no DB write if token is unchanged.
   */
  @Post('fcm-token')
  @HttpCode(HttpStatus.OK)
  async registerFcmToken(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterFcmTokenDto,
  ) {
    return this.notificationsService.registerFcmToken(user.sub, dto.token);
  }

  /**
   * DELETE /api/v1/notifications/fcm-token
   * Revokes the FCM token for the authenticated user (logout / permission denied).
   * Clears both DB and Redis cache.
   */
  @Delete('fcm-token')
  @HttpCode(HttpStatus.OK)
  async revokeFcmToken(@CurrentUser() user: JwtPayload) {
    await this.notificationsService.revokeFcmToken(user.sub);
    return { revoked: true, message: 'FCM token removed' };
  }

  /**
   * GET /api/v1/notifications/diagnostics
   * FR-NOTX-018 (ISSUE-16): admin-only delivery diagnostics — push channel
   * state, registered-device counts, and the last-send outcome — so
   * "notifications are on but nothing arrives" is observable.
   */
  @Get('diagnostics')
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async getDiagnostics(@CurrentUser() user: JwtPayload) {
    if (!user.organizationId) {
      throw new ForbiddenException('No organization context');
    }
    return this.notificationsService.getDiagnostics(user.organizationId);
  }
}
