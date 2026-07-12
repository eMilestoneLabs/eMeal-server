import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { GuestsService } from './guests.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { EmailVerifiedGuard } from '../../common/guards/email-verified.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  BookGuestsDto,
  UpdateGuestDto,
  QueryGuestsDto,
  ReviewGuestDto,
} from './dto/guest.dto';

const ADMIN_ROLES = [
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
] as const;

type Jwt = { sub: string; organizationId: string; role: string };

/**
 * GuestsController — Module 22 (FR-HG-080).
 *
 * Route map (all under /attendance, additive — no existing route changes):
 *   POST   /attendance/:mealId/guests        — book N guests (host, or admin
 *                                              on behalf → host confirmation)
 *   GET    /attendance/guests?date=&groupId= — list (member: own; admin: group)
 *   PATCH  /attendance/guests/:id            — edit name/preference (host)
 *   DELETE /attendance/guests/:id            — cancel (host in-window; admin any time)
 *   POST   /attendance/guests/:id/approve    — admin approves (guestRequiresApproval)
 *   POST   /attendance/guests/:id/reject     — admin rejects
 *   POST   /attendance/guests/:id/confirm    — HOST confirms an admin-added guest
 *   POST   /attendance/guests/:id/decline    — HOST declines an admin-added guest
 */
@UseGuards(JwtAuthGuard)
@Controller('attendance')
export class GuestsController {
  constructor(private readonly guestsService: GuestsService) {}

  @Get('guests')
  async listGuests(
    @CurrentUser() user: Jwt,
    @Query() query: QueryGuestsDto,
  ) {
    return this.guestsService.listGuests(
      user.sub, user.role, user.organizationId!, query,
    );
  }

  @Post('guests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async approveGuest(
    @CurrentUser() user: Jwt,
    @Param('id') id: string,
    @Body() dto: ReviewGuestDto,
    @Req() req: any,
  ) {
    return this.guestsService.approveGuest(
      user.sub, user.organizationId!, id, dto, req.requestId,
    );
  }

  @Post('guests/:id/reject')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ADMIN_ROLES)
  async rejectGuest(
    @CurrentUser() user: Jwt,
    @Param('id') id: string,
    @Body() dto: ReviewGuestDto,
    @Req() req: any,
  ) {
    return this.guestsService.rejectGuest(
      user.sub, user.organizationId!, id, dto, req.requestId,
    );
  }

  @Post('guests/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmGuest(
    @CurrentUser() user: Jwt,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.guestsService.confirmGuest(
      user.sub, user.organizationId!, id, req.requestId,
    );
  }

  @Post('guests/:id/decline')
  @HttpCode(HttpStatus.OK)
  async declineGuest(
    @CurrentUser() user: Jwt,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.guestsService.declineGuest(
      user.sub, user.organizationId!, id, req.requestId,
    );
  }

  @Patch('guests/:id')
  @HttpCode(HttpStatus.OK)
  async updateGuest(
    @CurrentUser() user: Jwt,
    @Param('id') id: string,
    @Body() dto: UpdateGuestDto,
    @Req() req: any,
  ) {
    return this.guestsService.updateGuest(
      user.sub, user.role, user.organizationId!, id, dto, req.requestId,
    );
  }

  @Delete('guests/:id')
  @HttpCode(HttpStatus.OK)
  async cancelGuest(
    @CurrentUser() user: Jwt,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    return this.guestsService.cancelGuest(
      user.sub, user.role, user.organizationId!, id, req.requestId,
    );
  }

  // Parameterised meal route LAST so 'guests' literals above win matching.
  // SRS Module 03 ACC-005: verification required to participate.
  @UseGuards(EmailVerifiedGuard)
  @Post(':mealId/guests')
  @HttpCode(HttpStatus.OK)
  async bookGuests(
    @CurrentUser() user: Jwt,
    @Param('mealId') mealId: string,
    @Body() dto: BookGuestsDto,
    @Req() req: any,
  ) {
    return this.guestsService.bookGuests(
      user.sub, user.role, user.organizationId!, mealId, dto, req.requestId,
    );
  }
}
