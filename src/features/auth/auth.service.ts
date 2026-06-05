import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomInt } from 'crypto';
import { ulid } from 'ulid';
import { UsersRepository } from '../users/repositories/users.repository';
import { AuthRepository } from './repositories/auth.repository';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../../audit/audit.service';
import { AuthSerializer } from './serializers/auth.serializer';
import { UserEntity } from '../users/entities/user.entity';
import { StudentSignupDto, AdminSignupDto, EventAdminSignupDto } from './dto/signup.dto';
import { LoginDto, OtpRequestDto, OtpVerifyDto } from './dto/login.dto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly authRepo: AuthRepository,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // ── SIGNUP ────────────────────────────────────────────────────────────────

  async signupStudent(dto: StudentSignupDto, requestId?: string) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { identifier: 'Email or phone number is required' },
      });
    }
    if (!dto.password) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { password: 'Password is required for signup' },
      });
    }

    await this.checkIdentifierAvailability(dto.email, dto.phone);

    const passwordHash = await bcrypt.hash(
      dto.password,
      this.configService.get<number>('app.bcryptRounds') ?? 12,
    );

    const user = await this.usersRepo.create({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      passwordHash,
      role: dto.role as UserRole,
      gender: dto.gender,
      age: dto.age,
      loginPreference: dto.loginPreference ?? (dto.email ? 'email' : 'mobile'),
    });

    await this.audit.log({
      actorId: user.id,
      targetId: user.id,
      targetType: 'User',
      action: 'create',
      requestId,
    });

    return this.issueTokensAndRespond(user);
  }

  async signupAdmin(dto: AdminSignupDto, requestId?: string) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { identifier: 'Email or phone number is required' },
      });
    }

    await this.checkIdentifierAvailability(dto.email, dto.phone);

    const passwordHash = await bcrypt.hash(
      dto.password,
      this.configService.get<number>('app.bcryptRounds') ?? 12,
    );

    // Create organization for admin if provided
    let organizationId: string | undefined;
    if (dto.organizationName) {
      const slug = dto.organizationSlug ??
        dto.organizationName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      // Ensure slug uniqueness
      const exists = await this.authRepo.slugExists(slug);
      if (exists) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { organizationSlug: 'Organization with this name already exists' },
        });
      }

      const org = await this.authRepo.createOrganization({
        name: dto.organizationName,
        slug,
      });
      organizationId = org.id;
    }

    const user = await this.usersRepo.create({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      passwordHash,
      role: dto.role as UserRole,
      gender: dto.gender,
      age: dto.age,
      organizationId,
      loginPreference: dto.loginPreference ?? (dto.email ? 'email' : 'mobile'),
    });

    await this.audit.log({
      organizationId,
      actorId: user.id,
      targetId: user.id,
      targetType: 'User',
      action: 'create',
      requestId,
    });

    return this.issueTokensAndRespond(user);
  }

  async signupEventAdmin(dto: EventAdminSignupDto, requestId?: string) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { identifier: 'Email or phone number is required' },
      });
    }

    await this.checkIdentifierAvailability(dto.email, dto.phone);

    const passwordHash = await bcrypt.hash(
      dto.password,
      this.configService.get<number>('app.bcryptRounds') ?? 12,
    );

    // Create a dedicated org for the event admin
    const slug = `event-${ulid().toLowerCase()}`;
    const org = await this.authRepo.createOrganization({
      name: dto.eventName,
      slug,
    });

    const user = await this.usersRepo.create({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      passwordHash,
      role: 'eventAdmin',
      organizationId: org.id,
      loginPreference: dto.email ? 'email' : 'mobile',
    });

    // Create the event immediately on signup
    const eventDate = new Date(dto.eventDate);
    const autoDeleteAt = dto.autoDeleteAfter7Days
      ? new Date(eventDate.getTime() + 7 * 24 * 60 * 60 * 1000)
      : undefined;

    await this.prisma.event.create({
      data: {
        organizationId: org.id,
        adminId: user.id,
        name: dto.eventName,
        type: dto.eventType as any,
        eventDate,
        expectedGuestCount: dto.expectedGuestCount ?? 0,
        autoDeleteAfter7Days: dto.autoDeleteAfter7Days ?? false,
        autoDeleteAt,
      },
    });

    await this.audit.log({
      organizationId: org.id,
      actorId: user.id,
      targetId: user.id,
      targetType: 'User',
      action: 'create',
      requestId,
    });

    return this.issueTokensAndRespond(user);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, meta: { userAgent?: string; ip?: string; requestId?: string }) {
    const user = await this.usersRepo.findByIdentifier(dto.identifier);

    if (!user) {
      throw new UnauthorizedException({
        message: 'Invalid credentials',
        errors: { identifier: 'No account found with this email or phone' },
      });
    }

    if (!user.isActive) {
      throw new UnauthorizedException({
        message: 'Account deactivated',
        errors: { identifier: 'Your account has been deactivated' },
      });
    }

    if (!dto.password) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { password: 'Password is required' },
      });
    }

    const rawUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!rawUser?.passwordHash) {
      throw new UnauthorizedException({
        message: 'Invalid credentials',
        errors: { password: 'This account uses OTP login. Please use OTP instead.' },
      });
    }

    const passwordValid = await bcrypt.compare(dto.password, rawUser.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException({
        message: 'Invalid credentials',
        errors: { password: 'Incorrect password' },
      });
    }

    // Update last login
    await this.usersRepo.update(user.id, { lastLoginAt: new Date() });

    await this.audit.log({
      organizationId: user.organizationId ?? undefined,
      actorId: user.id,
      targetId: user.id,
      targetType: 'User',
      action: 'login',
      metadata: { ip: meta.ip, userAgent: meta.userAgent },
      requestId: meta.requestId,
      ipAddress: meta.ip,
    });

    return this.issueTokensAndRespond(user, meta);
  }

  // ── OTP (Phase B1 placeholder — Firebase integration in Phase B7) ─────────

  async requestOtp(dto: OtpRequestDto, requestId?: string) {
    // Phase B1: Generate a simple OTP and store hashed version
    // In production Phase B7: delegate to Firebase Auth SMS
    const otp = (100000 + randomInt(900000)).toString(); // 6-digit, cryptographically secure
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const user = await this.usersRepo.findByIdentifier(dto.identifier);

    await this.authRepo.createOtpRequest({
      identifier: dto.identifier,
      otpHash,
      purpose: dto.purpose ?? 'login',
      expiresAt,
      userId: user?.id,
    });

    if (process.env.NODE_ENV === 'development') {
      this.logger.debug(
        `[DEV ONLY] OTP for ${dto.identifier}: ${otp} (expires ${expiresAt.toISOString()})`,
      );
    }

    return {
      message: 'OTP sent successfully',
      expiresIn: 600,
      // In development: return OTP for testing. REMOVE IN PRODUCTION.
      ...(process.env.NODE_ENV === 'development' ? { _devOtp: otp } : {}),
    };
  }

  async verifyOtp(dto: OtpVerifyDto, meta: { userAgent?: string; ip?: string; requestId?: string }) {
    const otpRecord = await this.authRepo.findValidOtpRequest(
      dto.identifier,
      dto.purpose ?? 'login',
    );

    if (!otpRecord) {
      throw new UnauthorizedException({
        message: 'Invalid or expired OTP',
        errors: { otp: 'OTP is invalid, expired, or already used' },
      });
    }

    const otpValid = await bcrypt.compare(dto.otp, otpRecord.otpHash);
    if (!otpValid) {
      await this.authRepo.incrementOtpAttempts(otpRecord.id);
      throw new UnauthorizedException({
        message: 'Invalid OTP',
        errors: { otp: 'Incorrect OTP code' },
      });
    }

    await this.authRepo.markOtpUsed(otpRecord.id);

    // Find or auto-create user for OTP login
    let user = await this.usersRepo.findByIdentifier(dto.identifier);
    if (!user) {
      // Auto-create minimal user for OTP signup flow
      const isEmail = dto.identifier.includes('@');
      user = await this.usersRepo.create({
        name: 'User',
        email: isEmail ? dto.identifier : undefined,
        phone: !isEmail ? dto.identifier : undefined,
        role: 'student',
        loginPreference: isEmail ? 'email' : 'mobile',
      });
    }

    await this.usersRepo.update(user.id, { lastLoginAt: new Date() });

    return this.issueTokensAndRespond(user, meta);
  }

  // ── REFRESH TOKEN ROTATION ─────────────────────────────────────────────────

  async refreshTokens(
    rawRefreshToken: string,
    meta: { userAgent?: string; ip?: string; requestId?: string },
  ) {
    // Verify JWT signature first
    let payload: { sub: string; family: string; organizationId: string | null; role: string };
    try {
      payload = this.jwtService.verify(rawRefreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException({
        message: 'Invalid refresh token',
        errors: { refreshToken: 'Token is invalid or expired' },
      });
    }

    const { sub: userId, family } = payload;

    // Check if entire family is revoked in Redis (logout / theft detection)
    const familyRevoked = await this.redis.isFamilyRevoked(family);
    if (familyRevoked) {
      throw new UnauthorizedException({
        message: 'Session expired',
        errors: { refreshToken: 'Please log in again' },
      });
    }

    // SHA-256 hash of the incoming token — deterministic, so the same token
    // always produces the same hash. This matches what was stored at issue time.
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');

    // Find token record in DB
    const tokenRecord = await this.authRepo.findRefreshTokenByHash(tokenHash).catch(() => null);

    if (!tokenRecord) {
      // Token not found — possible theft: a token from this family was reused
      // Revoke entire family to force re-login on all devices
      await this.authRepo.revokeAllTokensByFamily(family);
      await this.redis.revokeFamily(family);
      throw new UnauthorizedException({
        message: 'Security alert: session invalidated',
        errors: { refreshToken: 'Suspicious activity detected. Please log in again.' },
      });
    }

    if (tokenRecord.isRevoked) {
      // Revoked token reuse = theft detection
      await this.authRepo.revokeAllTokensByFamily(family);
      await this.redis.revokeFamily(family);
      throw new UnauthorizedException({
        message: 'Security alert: session invalidated',
        errors: { refreshToken: 'Token reuse detected. Please log in again.' },
      });
    }

    if (tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException({
        message: 'Session expired',
        errors: { refreshToken: 'Please log in again' },
      });
    }

    // Revoke the used token (rotation)
    await this.authRepo.revokeRefreshToken(tokenRecord.id);

    const user = await this.usersRepo.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account not found or deactivated');
    }

    // Issue new token pair in the same family
    return this.issueTokensAndRespond(user, meta, family);
  }

  // ── LOGOUT ─────────────────────────────────────────────────────────────────

  async logout(userId: string, rawRefreshToken?: string, requestId?: string) {
    if (rawRefreshToken) {
      try {
        const payload: any = this.jwtService.verify(rawRefreshToken, {
          secret: this.configService.get<string>('jwt.refreshSecret'),
        });
        if (payload.family) {
          await this.authRepo.revokeAllTokensByFamily(payload.family);
          await this.redis.revokeFamily(payload.family);
        }
      } catch {
        // Even if token is expired, attempt to revoke all user tokens
        await this.authRepo.revokeAllTokensByUser(userId);
      }
    } else {
      await this.authRepo.revokeAllTokensByUser(userId);
    }

    const user = await this.usersRepo.findById(userId);
    await this.audit.log({
      organizationId: user?.organizationId ?? undefined,
      actorId: userId,
      targetId: userId,
      targetType: 'User',
      action: 'logout',
      requestId,
    });

    return { message: 'Logged out successfully' };
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────

  /**
   * Issue access + refresh token pair and build response.
   * expiresIn is always INTEGER seconds (M-02 fix).
   */
  private async issueTokensAndRespond(
    user: UserEntity,
    meta?: { userAgent?: string; ip?: string },
    existingFamily?: string,
  ) {
    const family = existingFamily ?? ulid();
    const expiresIn = this.configService.get<number>('jwt.accessExpiresIn') ?? 900;
    const refreshExpiresIn = this.configService.get<number>('jwt.refreshExpiresIn') ?? 604800;

    const jwtPayload = {
      sub: user.id,
      organizationId: user.organizationId,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(jwtPayload, {
      secret: this.configService.get<string>('jwt.accessSecret'),
      expiresIn,
    });

    const refreshPayload = { ...jwtPayload, family };
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      expiresIn: refreshExpiresIn,
    });

    // Store deterministic SHA-256 hash of refresh token for DB lookup.
    // bcrypt CANNOT be used here — it is non-deterministic (random salt each call),
    // so rehashing the same token would produce a different hash and findUnique would fail.
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + refreshExpiresIn * 1000);

    await this.authRepo.createRefreshToken({
      userId: user.id,
      tokenHash,
      family,
      expiresAt,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ip,
    });

    // Track family in Redis
    await this.redis.addTokenToFamily(family, tokenHash, refreshExpiresIn);

    return AuthSerializer.toResponse({
      accessToken,
      refreshToken,
      expiresIn, // INTEGER — Flutter primary field (M-02)
      user,
    });
  }


  // ── FCM TOKEN ─────────────────────────────────────────────────────────────

  /**
   * B6: Register or update FCM push token for a user.
   * POST /auth/fcm-token — authenticated endpoint.
   */
  async updateFcmToken(userId: string, token: string, requestId?: string): Promise<{ message: string }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: token },
    });

    this.logger.debug(`FCM token updated for userId=${userId} requestId=${requestId}`);
    return { message: 'FCM token registered successfully' };
  }

    private async checkIdentifierAvailability(email?: string, phone?: string) {
    if (email) {
      const emailExists = await this.usersRepo.existsByEmail(email);
      if (emailExists) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { email: 'Email already registered' },
          statusCode: 409,
        });
      }
    }
    if (phone) {
      const phoneExists = await this.usersRepo.existsByPhone(phone);
      if (phoneExists) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { mobileNumber: 'Mobile number already registered' },
          statusCode: 409,
        });
      }
    }
  }
}
