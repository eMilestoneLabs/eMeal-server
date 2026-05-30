import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { StudentSignupDto, AdminSignupDto, EventAdminSignupDto } from './dto/signup.dto';
import { LoginDto, OtpRequestDto, OtpVerifyDto, RefreshTokenDto } from './dto/login.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
  @Public()
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(@Body() body: any, @Req() req: Request) {
    const role = body.role ?? 'student';
    if (['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'].includes(role)) {
      return this.authService.signupAdmin(body as AdminSignupDto, req.requestId);
    }
    if (role === 'eventAdmin') {
      return this.authService.signupEventAdmin(body as EventAdminSignupDto, req.requestId);
    }
    return this.authService.signupStudent(body as StudentSignupDto, req.requestId);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 req/min (auth rate limit)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      requestId: req.requestId,
    });
  }

  // ── OTP ───────────────────────────────────────────────────────────────────

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 req/min (OTP rate limit)
  async requestOtp(@Body() dto: OtpRequestDto, @Req() req: Request) {
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
}
