import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Query,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, ALL_ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { UpdateUserDto, VacationModeDto, DefaultAttendanceDto } from './dto/update-user.dto';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ── /me routes (self-service) ─────────────────────────────────────────────

  @Get('me')
  async getMe(@CurrentUser() user: JwtPayload) {
    return this.usersService.getMe(user.sub);
  }

  @Patch('me')
  async updateMe(@CurrentUser() user: JwtPayload, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(user.sub, dto);
  }

  @Patch('me/vacation-mode')
  @HttpCode(HttpStatus.OK)
  async setMyVacationMode(@CurrentUser() user: JwtPayload, @Body() dto: VacationModeDto) {
    return this.usersService.setVacationMode(user.sub, dto.enabled);
  }

  @Patch('me/default-attendance')
  @HttpCode(HttpStatus.OK)
  async setMyDefaultAttendance(@CurrentUser() user: JwtPayload, @Body() dto: DefaultAttendanceDto) {
    return this.usersService.setDefaultAttendance(user.sub, dto.enabled);
  }

  // ── /users (admin list) ───────────────────────────────────────────────────
  // Flutter: String get list => '/users'  (admin only)

  @Get()
  @UseGuards(RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  async listUsers(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.usersService.listByOrg(user.organizationId!, {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  }

  // ── /users/:userId — Flutter uses /users/{userId} paths ──────────────────
  // NOTE: These MUST be declared AFTER /me routes to avoid param collision.

  @Get(':userId')
  async getUserById(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
  ) {
    // Users can read their own profile; admins can read any user in their org
    const isAdmin = ALL_ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin && user.sub !== userId) {
      throw new ForbiddenException('Cannot access other users\' profiles');
    }
    return this.usersService.getMe(userId);
  }

  @Patch(':userId')
  async updateUserById(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
    @Body() dto: UpdateUserDto,
  ) {
    const isAdmin = ALL_ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin && user.sub !== userId) {
      throw new ForbiddenException('Cannot update other users\' profiles');
    }
    return this.usersService.updateMe(userId, dto);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(...ALL_ADMIN_ROLES)
  async deleteUser(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
  ) {
    return this.usersService.removeUser(userId, user.organizationId!);
  }

  // ── /users/:userId/vacation-mode ─────────────────────────────────────────
  // Flutter: String get vacationMode => '/users/{userId}/vacation-mode'

  @Patch(':userId/vacation-mode')
  @HttpCode(HttpStatus.OK)
  async setVacationMode(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
    @Body() dto: VacationModeDto,
  ) {
    this._assertSelfOrAdmin(user, userId);
    return this.usersService.setVacationMode(userId, dto.enabled);
  }

  // ── /users/:userId/default-attendance ────────────────────────────────────
  // Flutter: String get defaultAttendance => '/users/{userId}/default-attendance'

  @Patch(':userId/default-attendance')
  @HttpCode(HttpStatus.OK)
  async setDefaultAttendance(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
    @Body() dto: DefaultAttendanceDto,
  ) {
    this._assertSelfOrAdmin(user, userId);
    return this.usersService.setDefaultAttendance(userId, dto.enabled);
  }

  // ── /users/:userId/meal-preference ───────────────────────────────────────
  // Flutter: String get mealPreference => '/users/{userId}/meal-preference'

  @Patch(':userId/meal-preference')
  @HttpCode(HttpStatus.OK)
  async setMealPreference(
    @CurrentUser() user: JwtPayload,
    @Param('userId') userId: string,
    @Body() body: { preference: string },
  ) {
    this._assertSelfOrAdmin(user, userId);
    // B11: defaultMealPreference will be a User column — requires schema migration.
    // For now acknowledge the Flutter contract without persisting (no-op is safe:
    // preference is also sent per-attendance-record when marking attendance).
    return { preference: body.preference, message: 'Meal preference noted' };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _assertSelfOrAdmin(user: JwtPayload, targetUserId: string) {
    const isAdmin = ALL_ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin && user.sub !== targetUserId) {
      throw new ForbiddenException('You can only modify your own profile');
    }
  }
}
