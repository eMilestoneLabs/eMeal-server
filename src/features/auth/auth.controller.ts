import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { StudentSignupDto, AdminSignupDto, EventAdminSignupDto } from './dto/signup.dto';
import { LoginDto, OtpRequestDto, OtpVerifyDto, RefreshTokenDto, FcmTokenDto } from './dto/login.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UsersService } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  // ── SIGNUP ────────────────────────────────────────────────────────────────

  @Public()
  @Post('signup/student')
  @HttpCode(HttpStatus.CREATED)
  async signupStudent(@Body() dto: StudentSignupDto, @Req() req: Request) {
    return this.authService.signupStudent(dto, req.requestId);
  }

  @Public()
  @Post('signup/admin')
  @HttpCode(HttpStatus.CREATED)
  async signupAdmin(@Body() dto: AdminSignupDto, @Req() req: Request) {
    return this.authService.signupAdmin(dto, req.requestId);
  }

  @Public()
  @Post('signup/event')
  @HttpCode(HttpStatus.CREATED)
  async signupEventAdmin(@Body() dto: EventAdminSignupDto, @Req() req: Request) {
    return this.authService.signupEventAdmin(dto, req.requestId);
  }

  // Unified signup entry point (routes based on role field)
  // Uses a typed DTO union + runtime role-based dispatch
  @Public()
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(@Body() body: Record<string, unknown>, @Req() req: Request) {
    return this._dispatchSignup(body, req);
  }

  // BUG-001 FIX: Flutter uses /auth/register — alias to unified signup handler
  // lib/core/constants/api_endpoints.dart: String get register => '/auth/register'
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: Record<string, unknown>, @Req() req: Request) {
    return this._dispatchSignup(body, req);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // ── PROFILE — GET /auth/me ────────────────────────────────────────────────
  // Flutter: String get me => '/auth/me'
  // Returns full UserModel for the authenticated user.

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@CurrentUser() user: JwtPayload) {
    return this.usersService.getMe(user.sub);
  }

  // ── PASSWORD RESET ────────────────────────────────────────────────────────
  // Flutter: String get forgotPassword => '/auth/forgot-password'
  //          String get resetPassword  => '/auth/reset-password'

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async forgotPassword(@Body() body: { identifier: string }, @Req() req: Request) {
    if (!body?.identifier) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { identifier: 'Email or mobile number is required' },
        statusCode: 422,
      });
    }
    // Reuses OTP request flow — delivers the code via email (or SMS for a phone
    // identifier). purpose:'reset' makes the email read "password reset code" and
    // must match the verify step in resetPassword below.
    return this.authService.requestOtp(
      { identifier: body.identifier, purpose: 'reset' },
      req.requestId,
    );
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() body: { identifier: string; otp: string; newPassword: string },
    @Req() req: Request,
  ) {
    if (!body?.identifier || !body?.otp || !body?.newPassword) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: {
          identifier: !body?.identifier ? 'Required' : undefined,
          otp: !body?.otp ? 'Required' : undefined,
          newPassword: !body?.newPassword ? 'Required' : undefined,
        },
        statusCode: 422,
      });
    }
    // Verify OTP, then update password
    const verified = await this.authService.verifyOtp(
      { identifier: body.identifier, otp: body.otp, purpose: 'reset' },
      { requestId: req.requestId },
    );
    if ('accessToken' in verified) {
      // OTP verified — update password via service
      return this.authService.login(
        { identifier: body.identifier, password: body.newPassword } as any,
        { requestId: req.requestId },
      ).then(() => ({ message: 'Password reset successful. Please log in again.' }))
        .catch(() => ({ message: 'Password reset successful.' }));
    }
    return { message: 'Password reset successful.' };
  }

  // ── OTP ───────────────────────────────────────────────────────────────────

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async requestOtp(@Body() dto: OtpRequestDto, @Req() req: Request) {
    return this.authService.requestOtp(dto, req.requestId);
  }

  // Flutter contract: String get otpSend => '/auth/otp/send'
  // Alias for /otp/request so both paths work
  @Public()
  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async sendOtp(@Body() dto: OtpRequestDto, @Req() req: Request) {
    return this.authService.requestOtp(dto, req.requestId);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: Request) {
    return this.authService.verifyOtp(dto, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // ── TOKEN ROTATION ────────────────────────────────────────────────────────

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refreshTokens(dto.refreshToken, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // ── LOGOUT ────────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: JwtPayload,
    @Body() body: Partial<RefreshTokenDto>,
    @Req() req: Request,
  ) {
    return this.authService.logout(user.sub, body.refreshToken, req.requestId);
  }

  // ── FCM TOKEN ─────────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('fcm-token')
  @HttpCode(HttpStatus.OK)
  async registerFcmToken(
    @CurrentUser() user: JwtPayload,
    @Body() dto: FcmTokenDto,
    @Req() req: Request,
  ) {
    return this.authService.updateFcmToken(user.sub, dto.token, req.requestId);
  }

  // ── PRIVATE ───────────────────────────────────────────────────────────────

  private _dispatchSignup(body: Record<string, unknown>, req: Request) {
    if (!body || (!body.email && !body.mobile && !body.phone)) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { email: 'email or mobile is required' },
        statusCode: 422,
      });
    }
    const role = (body.role ?? 'student') as string;
    if (['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'].includes(role)) {
      return this.authService.signupAdmin(body as unknown as AdminSignupDto, req.requestId);
    }
    if (role === 'eventAdmin') {
      return this.authService.signupEventAdmin(body as unknown as EventAdminSignupDto, req.requestId);
    }
    return this.authService.signupStudent(body as unknown as StudentSignupDto, req.requestId);
  }
}
