import {
  Controller,
  Get,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { UpdateUserDto, VacationModeDto, DefaultAttendanceDto } from './dto/update-user.dto';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * GET /api/v1/users/me
   * Returns full UserModel JSON — Flutter contract from user_model.dart
   */
  @Get('me')
  async getMe(@CurrentUser() user: JwtPayload) {
    return this.usersService.getMe(user.sub);
  }

  /**
   * PATCH /api/v1/users/me
   * Update profile fields
   */
  @Patch('me')
  async updateMe(@CurrentUser() user: JwtPayload, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(user.sub, dto);
  }

  /**
   * PATCH /api/v1/users/me/vacation-mode
   * Toggle vacation mode — disables attendance reminders and auto-marking
   */
  @Patch('me/vacation-mode')
  @HttpCode(HttpStatus.OK)
  async setVacationMode(
    @CurrentUser() user: JwtPayload,
    @Body() dto: VacationModeDto,
  ) {
    return this.usersService.setVacationMode(user.sub, dto.enabled);
  }

  /**
   * PATCH /api/v1/users/me/default-attendance
   * Toggle default attendance mode — auto-marks user as present
   */
  @Patch('me/default-attendance')
  @HttpCode(HttpStatus.OK)
  async setDefaultAttendance(
    @CurrentUser() user: JwtPayload,
    @Body() dto: DefaultAttendanceDto,
  ) {
    return this.usersService.setDefaultAttendance(user.sub, dto.enabled);
  }
}
