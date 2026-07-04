import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
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
import { MailerService } from '../../shared/mailer/mailer.service';
import { SmsService } from '../../shared/sms/sms.service';

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
    private readonly mailer: MailerService,
    private readonly sms: SmsService,
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

    // AUTH-031/036: send Email verification OTP after successful signup.
    await this.sendSignupEmailVerification(user.email ?? undefined, user.id);

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

    // BUGFIX (Admin.md: "Organization created automatically on signup, slug
    // generated from name"): an organization is auto-created for EVERY admin.
    // The frozen admin signup form sends no organizationName, so we derive one
    // from the admin's name; an explicit organizationName is still honored.
    // Without this, admins had organizationId=null and could not create groups.
    const orgName =
      dto.organizationName && dto.organizationName.trim()
        ? dto.organizationName.trim()
        : `${dto.name}'s Organization`;

    const baseSlug =
      (((dto.organizationSlug && dto.organizationSlug.trim()) || orgName)
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')) || 'org';

    // Ensure slug uniqueness. An explicit organizationName collision is rejected
    // (preserves prior behavior); an auto-derived slug gets a short unique suffix
    // so signup never fails for two admins with the same name.
    let slug = baseSlug;
    if (await this.authRepo.slugExists(slug)) {
      if (dto.organizationName) {
        throw new ConflictException({
          message: 'Validation failed',
          errors: { organizationSlug: 'Organization with this name already exists' },
        });
      }
      slug = `${baseSlug}-${ulid().slice(-6).toLowerCase()}`;
    }

    const org = await this.authRepo.createOrganization({ name: orgName, slug });
    const organizationId: string = org.id;

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

    // AUTH-031/036: send Email verification OTP after successful signup.
    await this.sendSignupEmailVerification(user.email ?? undefined, user.id);

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

    // AUTH-031/036: send Email verification OTP after successful signup.
    await this.sendSignupEmailVerification(user.email ?? undefined, user.id);

    return this.issueTokensAndRespond(user);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────────────

  /**
   * Emails are case-insensitive identifiers: normalize once at every auth
   * entry point so login, OTP request/verify and reset all agree regardless
   * of how the user typed it (repo lookups are insensitive too — accounts
   * created before 2026-07-04 store mixed case).
   */
  private static normalizeIdentifier(identifier: string): string {
    const trimmed = identifier.trim();
    return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed;
  }

  async login(dto: LoginDto, meta: { userAgent?: string; ip?: string; requestId?: string }) {
    dto.identifier = AuthService.normalizeIdentifier(dto.identifier ?? '');
    // SEC-005 / ERR-003: a single generic credential error for every "wrong
    // email/mobile OR wrong password" case so the endpoint cannot be used to
    // enumerate which accounts exist.
    const invalidCredentials = () =>
      new UnauthorizedException({
        message: 'Invalid email/mobile or password',
        errors: { identifier: 'Invalid email/mobile or password' },
      });

    if (!dto.password) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: { password: 'Password is required' },
      });
    }

    const user = await this.usersRepo.findByIdentifier(dto.identifier);

    if (!user) {
      // SEC-006: audit the failed attempt (no actor — account is unknown).
      await this.audit.log({
        targetType: 'User',
        action: 'login',
        metadata: { success: false, reason: 'no_account', identifier: this.maskIdentifier(dto.identifier) },
        requestId: meta.requestId,
        ipAddress: meta.ip,
      });
      throw invalidCredentials();
    }

    if (!user.isActive) {
      throw new UnauthorizedException({
        message: 'Account deactivated',
        errors: { identifier: 'Your account has been deactivated' },
      });
    }

    const rawUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!rawUser?.passwordHash) {
      // Account has no password (OTP-only). Stay generic to avoid enumeration.
      throw invalidCredentials();
    }

    const passwordValid = await bcrypt.compare(dto.password, rawUser.passwordHash);
    if (!passwordValid) {
      await this.audit.log({
        organizationId: user.organizationId ?? undefined,
        actorId: user.id,
        targetId: user.id,
        targetType: 'User',
        action: 'login',
        metadata: { success: false, reason: 'bad_password' },
        requestId: meta.requestId,
        ipAddress: meta.ip,
      });
      throw invalidCredentials();
    }

    // Update last login
    await this.usersRepo.update(user.id, { lastLoginAt: new Date() });

    await this.audit.log({
      organizationId: user.organizationId ?? undefined,
      actorId: user.id,
      targetId: user.id,
      targetType: 'User',
      action: 'login',
      metadata: { success: true, method: 'password', ip: meta.ip, userAgent: meta.userAgent },
      requestId: meta.requestId,
      ipAddress: meta.ip,
    });

    return this.issueTokensAndRespond(user, meta);
  }

  // ── OTP (Phase B1 placeholder — Firebase integration in Phase B7) ─────────

  async requestOtp(dto: OtpRequestDto, requestId?: string) {
    dto.identifier = AuthService.normalizeIdentifier(dto.identifier ?? '');
    const cfg = this.authConfig();
    const isEmail = dto.identifier.includes('@');
    const purpose = dto.purpose ?? 'login';

    // SEC-008 / AUTH-016: Mobile OTP is a future feature and must not be callable.
    // Email OTP login (AUTH-015) and Forgot Password (AUTH-017) are Email-only here.
    if (!isEmail && !cfg.mobileOtpEnabled) {
      throw new BadRequestException({
        message: 'Mobile OTP is coming soon. Please use Email OTP.',
        errors: { identifier: 'Mobile OTP — Coming Soon' },
      });
    }

    const otp = this.generateOtp(cfg.otp.length); // cryptographically secure
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + cfg.otp.ttlSeconds * 1000);
    const ttlMinutes = Math.max(1, Math.round(cfg.otp.ttlSeconds / 60));

    const user = await this.usersRepo.findByIdentifier(dto.identifier);

    // AUTH-037 + SEC-005 (Option B — anti-enumeration): a reset code is delivered
    // ONLY to a registered address that matches the workspace it was requested
    // from, but the endpoint NEVER reveals whether an account exists or its role.
    // When there is no matching account we silently skip generation/delivery and
    // return an identical generic success. A reset can never succeed without a
    // server-stored OTP, so a wrong/unknown email is a harmless dead-end.
    if (purpose === 'reset') {
      // STRICT workspace isolation (security): a reset code is sent ONLY when the
      // account exists AND belongs to the workspace the request came from. An
      // absent OR mismatched roleContext yields an identical generic success with
      // NO code — so an Admin account can never be reset from the Student flow
      // (and vice-versa), and the endpoint still never enumerates accounts.
      const matches =
        !!user &&
        !!dto.roleContext &&
        this.roleMatchesContext(user.role, dto.roleContext);
      if (!matches) {
        this.logger.warn(
          'Password reset unmatched (unknown / wrong-workspace / missing context) — generic success, no code sent',
        );
        return {
          message: AuthService._resetGenericMessage,
          expiresIn: cfg.otp.ttlSeconds,
        };
      }
    }

    await this.authRepo.createOtpRequest({
      identifier: dto.identifier,
      otpHash,
      purpose,
      expiresAt,
      userId: user?.id,
    });

    // Delivery is best-effort AND fire-and-forget — the OTP is already stored and
    // the response is identical regardless of send outcome, so we never block the
    // request on the SMTP/SMS round-trip (keeps the endpoint ultra-fast).
    if (isEmail) {
      void this.mailer
        .sendOtp(dto.identifier, otp, purpose, ttlMinutes)
        .then((sent) => {
          if (!sent) {
            this.logger.warn(
              `OTP email not delivered for ${dto.identifier} (SMTP disabled or send failed) — code still valid`,
            );
          }
        })
        .catch((err) =>
          this.logger.warn(`OTP email error for ${dto.identifier}: ${(err as Error).message}`),
        );
    } else {
      // Reachable only when MOBILE_OTP_ENABLED=true (future release).
      void this.sms
        .sendOtp(dto.identifier, otp)
        .then((sent) => {
          if (!sent) {
            this.logger.warn(
              `OTP SMS not delivered for ${dto.identifier} (SMS disabled or send failed) — code still valid`,
            );
          }
        })
        .catch((err) =>
          this.logger.warn(`OTP SMS error for ${dto.identifier}: ${(err as Error).message}`),
        );
    }

    if (process.env.NODE_ENV === 'development') {
      this.logger.debug(
        `[DEV ONLY] OTP for ${dto.identifier}: ${otp} (expires ${expiresAt.toISOString()})`,
      );
    }

    // For reset, return the SAME shared message as the no-match branch above
    // (anti-enumeration — responses must be byte-identical). Login/signup get a
    // normal confirmation.
    const message = purpose === 'reset' ? AuthService._resetGenericMessage : 'OTP sent successfully';

    return {
      message,
      expiresIn: cfg.otp.ttlSeconds,
      // In development: return OTP for testing. REMOVE IN PRODUCTION.
      ...(process.env.NODE_ENV === 'development' ? { _devOtp: otp } : {}),
    };
  }

  async verifyOtp(dto: OtpVerifyDto, meta: { userAgent?: string; ip?: string; requestId?: string }) {
    dto.identifier = AuthService.normalizeIdentifier(dto.identifier ?? '');
    const cfg = this.authConfig();
    const otpRecord = await this.authRepo.findValidOtpRequest(
      dto.identifier,
      dto.purpose ?? 'login',
      cfg.otp.maxAttempts,
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

    await this.authRepo.markOtpUsed(otpRecord.id); // SEC-007: single-use OTP

    // Find or auto-create user for OTP login
    const isEmail = dto.identifier.includes('@');
    let user = await this.usersRepo.findByIdentifier(dto.identifier);
    if (!user) {
      // Auto-create minimal user for OTP signup flow
      user = await this.usersRepo.create({
        name: 'User',
        email: isEmail ? dto.identifier : undefined,
        phone: !isEmail ? dto.identifier : undefined,
        role: 'student',
        loginPreference: isEmail ? 'email' : 'mobile',
      });
    }

    // SRS AUTH-036/040: a successful Email OTP proves ownership → mark verified.
    if (isEmail && !user.emailVerifiedAt) {
      const verifiedAt = new Date();
      await this.usersRepo.update(user.id, { emailVerifiedAt: verifiedAt });
      user.emailVerifiedAt = verifiedAt;
      await this.audit.log({
        organizationId: user.organizationId ?? undefined,
        actorId: user.id,
        targetId: user.id,
        targetType: 'User',
        action: 'update',
        metadata: { event: 'email_verified' },
        requestId: meta.requestId,
        ipAddress: meta.ip,
      });
    }

    await this.usersRepo.update(user.id, { lastLoginAt: new Date() });

    // SEC-006: audit successful OTP login.
    await this.audit.log({
      organizationId: user.organizationId ?? undefined,
      actorId: user.id,
      targetId: user.id,
      targetType: 'User',
      action: 'login',
      metadata: { success: true, method: 'otp', ip: meta.ip, userAgent: meta.userAgent },
      requestId: meta.requestId,
      ipAddress: meta.ip,
    });

    return this.issueTokensAndRespond(user, meta);
  }

  // ── PASSWORD RESET (AUTH-017, Part 4 §3) ────────────────────────────────────

  /**
   * Reset a password using an Email OTP. Verifies the single-use OTP, hashes and
   * stores the new password, and (configurably) revokes all existing sessions so
   * the previous password becomes invalid immediately (Part 7 §2). Email-only —
   * Mobile OTP recovery is a future feature (SEC-008).
   */
  async resetPassword(
    identifier: string,
    otp: string,
    newPassword: string,
    meta: { userAgent?: string; ip?: string; requestId?: string } = {},
  ): Promise<{ message: string }> {
    identifier = AuthService.normalizeIdentifier(identifier ?? '');
    // AUTH-017: Forgot/Reset Password is Email OTP only in the current release.
    if (!identifier.includes('@')) {
      throw new BadRequestException({
        message: 'Password reset is available via email only.',
        errors: { identifier: 'Use your registered email address' },
      });
    }

    const cfg = this.authConfig();
    const otpRecord = await this.authRepo.findValidOtpRequest(identifier, 'reset', cfg.otp.maxAttempts);
    if (!otpRecord) {
      throw new UnauthorizedException({
        message: 'Invalid or expired OTP',
        errors: { otp: 'OTP is invalid, expired, or already used' },
      });
    }

    const otpValid = await bcrypt.compare(otp, otpRecord.otpHash);
    if (!otpValid) {
      await this.authRepo.incrementOtpAttempts(otpRecord.id);
      throw new UnauthorizedException({
        message: 'Invalid OTP',
        errors: { otp: 'Incorrect OTP code' },
      });
    }

    await this.authRepo.markOtpUsed(otpRecord.id); // single-use

    const user = await this.usersRepo.findByIdentifier(identifier);
    if (!user) {
      // OTP validated against an identifier with no account — stay generic.
      throw new BadRequestException({
        message: 'Unable to reset password.',
        errors: { identifier: 'Unable to reset password' },
      });
    }

    const passwordHash = await bcrypt.hash(
      newPassword,
      this.configService.get<number>('app.bcryptRounds') ?? 12,
    );

    // A successful reset also proves email ownership → mark verified if it wasn't.
    await this.usersRepo.update(user.id, {
      passwordHash,
      ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
    });

    // Part 4 §3 / Part 7 §2: previous password invalid immediately; optionally
    // invalidate every existing session.
    if (cfg.resetPasswordInvalidatesSessions) {
      await this.authRepo.revokeAllTokensByUser(user.id);
    }

    await this.audit.log({
      organizationId: user.organizationId ?? undefined,
      actorId: user.id,
      targetId: user.id,
      targetType: 'User',
      action: 'update',
      metadata: { event: 'password_reset' },
      requestId: meta.requestId,
      ipAddress: meta.ip,
    });

    return { message: 'Password reset successful. Please log in again.' };
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

    // Rotation-reuse GRACE (mobile false-positive fix): when THIS exact token
    // was rotated moments ago, its reappearance is almost always a retry after
    // a lost response (flaky network / OS killed the app before the new pair
    // was persisted) — not theft. Within the short grace window we continue
    // the SAME family with a fresh pair instead of nuking it. Real theft — an
    // old token replayed after the window — still kills the family below.
    const graceActive = await this.redis
      .exists(`auth:refresh:grace:${tokenHash}`)
      .catch(() => false);

    if ((!tokenRecord || tokenRecord.isRevoked) && graceActive) {
      const user = await this.usersRepo.findById(userId);
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Account not found or deactivated');
      }
      this.logger.warn(
        `Refresh grace hit — rotation retry within window user=${userId} family=${family}`,
      );
      return this.issueTokensAndRespond(user, meta, family, tokenRecord?.id);
    }

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
      // Successor-usage rescue (works at ANY elapsed time, unlike the 90s
      // Redis grace): if the successor issued when THIS token was rotated has
      // NEVER been used, the client provably never received the rotation
      // response (OS killed the app / network drop mid-flight). That is a lost
      // response, not theft — retire the undelivered successor and continue
      // the SAME family. If the successor WAS used, two parties hold tokens
      // from one rotation = genuine fork → nuke below, exactly as before.
      if (tokenRecord.replacedById && tokenRecord.expiresAt >= new Date()) {
        const successor = await this.authRepo
          .findRefreshTokenById(tokenRecord.replacedById)
          .catch(() => null);
        if (successor && !successor.usedAt && !successor.isRevoked) {
          await this.authRepo.revokeRefreshToken(successor.id);
          const user = await this.usersRepo.findById(userId);
          if (!user || !user.isActive) {
            throw new UnauthorizedException('Account not found or deactivated');
          }
          this.logger.warn(
            `Refresh successor-rescue — undelivered rotation recovered user=${userId} family=${family}`,
          );
          return this.issueTokensAndRespond(user, meta, family, tokenRecord.id);
        }
      }

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

    // Rotation: the used token is revoked + linked to its successor inside
    // issueTokensAndRespond (markRefreshTokenRotated). Open the short Redis
    // reuse-grace window as a fast path for immediate lost-response retries;
    // the successor-usage check above covers retries at any later time.
    const graceSeconds =
      this.configService.get<number>('auth.refreshGraceSeconds') ?? 90;
    if (graceSeconds > 0) {
      await this.redis
        .set(`auth:refresh:grace:${tokenHash}`, '1', graceSeconds)
        .catch(() => undefined); // grace is best-effort, never blocks refresh
    }

    const user = await this.usersRepo.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account not found or deactivated');
    }

    // Issue new token pair in the same family, linking the rotated token
    return this.issueTokensAndRespond(user, meta, family, tokenRecord.id);
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
    rotatedFromId?: string,
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

    const refreshPayload = { ...jwtPayload, family, jti: ulid() };
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.configService.get<string>('jwt.refreshSecret'),
      expiresIn: refreshExpiresIn,
    });

    // Store deterministic SHA-256 hash of refresh token for DB lookup.
    // bcrypt CANNOT be used here — it is non-deterministic (random salt each call),
    // so rehashing the same token would produce a different hash and findUnique would fail.
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + refreshExpiresIn * 1000);

    const created = await this.authRepo.createRefreshToken({
      userId: user.id,
      tokenHash,
      family,
      expiresAt,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ip,
    });

    // Rotation lineage: revoke the redeemed token and point it at its
    // successor, so an undelivered successor can be recognized later
    // (lost-response rescue) instead of tripping theft detection.
    if (rotatedFromId && created?.id) {
      await this.authRepo.markRefreshTokenRotated(rotatedFromId, created.id);
    }

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
    // Issue 5: email + mobile are unique across the ENTIRE user base (any role).
    // The error names which workspace already owns the identifier so the user
    // knows where their existing account lives.
    if (email) {
      const existing = await this.usersRepo.findByEmail(email);
      if (existing) {
        const label = this.workspaceLabel(this.contextForRole(existing.role));
        throw new ConflictException({
          message: 'Validation failed',
          errors: { email: `This email already has a ${label} account` },
          statusCode: 409,
        });
      }
    }
    if (phone) {
      const existing = await this.usersRepo.findByPhone(phone);
      if (existing) {
        const label = this.workspaceLabel(this.contextForRole(existing.role));
        throw new ConflictException({
          message: 'Validation failed',
          errors: { mobileNumber: `This mobile number already has a ${label} account` },
          statusCode: 409,
        });
      }
    }
  }

  // ── Role ⇄ workspace mapping (Issue 5) ──────────────────────────────────────

  private static readonly _adminRoles = [
    'messManager', 'hostelManager', 'hostelAdmin', 'organizationManager',
  ];
  private static readonly _eventRoles = ['eventAdmin', 'eventGuest'];

  // Single source for the reset response so the "sent" and "not-sent" branches
  // return a BYTE-IDENTICAL message (anti-enumeration, SEC-005). Never split.
  private static readonly _resetGenericMessage =
    'If an account exists for this email, a reset code has been sent.';

  private contextForRole(role: string): 'student' | 'admin' | 'event' {
    if (AuthService._adminRoles.includes(role)) return 'admin';
    if (AuthService._eventRoles.includes(role)) return 'event';
    return 'student';
  }

  private roleMatchesContext(role: string, context: string): boolean {
    return this.contextForRole(role) === context;
  }

  private workspaceLabel(context?: string): string {
    switch (context) {
      case 'admin':
        return 'Admin/Manager';
      case 'event':
        return 'Event';
      default:
        return 'Student/Member';
    }
  }

  // ── OTP / AUTH config + small helpers ───────────────────────────────────────

  /** Read the centralized auth config with safe fallbacks (no hardcoded values). */
  private authConfig() {
    return {
      otp: {
        ttlSeconds: this.configService.get<number>('auth.otp.ttlSeconds') ?? 600,
        length: this.configService.get<number>('auth.otp.length') ?? 6,
        maxAttempts: this.configService.get<number>('auth.otp.maxAttempts') ?? 5,
      },
      resetPasswordInvalidatesSessions:
        this.configService.get<boolean>('auth.resetPasswordInvalidatesSessions') ?? true,
      mobileOtpEnabled: this.configService.get<boolean>('auth.mobileOtpEnabled') ?? false,
    };
  }

  /** Cryptographically secure numeric OTP of the configured length. */
  private generateOtp(length: number): string {
    const len = Math.max(4, Math.min(10, length || 6));
    const min = 10 ** (len - 1);
    const span = 10 ** len - min;
    return (min + randomInt(span)).toString();
  }

  /** Mask an email/phone for audit metadata (avoid storing full PII). */
  private maskIdentifier(identifier: string): string {
    if (identifier.includes('@')) {
      const [local, domain] = identifier.split('@');
      const head = local.slice(0, 2);
      return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain ?? ''}`;
    }
    return identifier.length > 4
      ? `${identifier.slice(0, 2)}***${identifier.slice(-2)}`
      : '***';
  }

  /**
   * SRS AUTH-031/036: send an Email verification OTP after a successful signup.
   * Best-effort — the account already exists, so a mail/transport failure must
   * never fail signup. The code is verifiable later via /auth/otp/verify.
   */
  private async sendSignupEmailVerification(email?: string, userId?: string): Promise<void> {
    if (!email) return;
    try {
      const cfg = this.authConfig();
      const otp = this.generateOtp(cfg.otp.length);
      const otpHash = await bcrypt.hash(otp, 10);
      const expiresAt = new Date(Date.now() + cfg.otp.ttlSeconds * 1000);
      const ttlMinutes = Math.max(1, Math.round(cfg.otp.ttlSeconds / 60));

      await this.authRepo.createOtpRequest({
        identifier: email,
        otpHash,
        purpose: 'signup',
        expiresAt,
        userId,
      });

      if (process.env.NODE_ENV === 'development') {
        this.logger.debug(`[DEV ONLY] signup verification OTP for ${email}: ${otp}`);
      }

      // Fire-and-forget the SMTP send so signup token issuance is NOT blocked on
      // the mail round-trip (ultra-fast auth). The OTP row is already persisted,
      // so verification works the moment the email arrives.
      void this.mailer
        .sendOtp(email, otp, 'signup', ttlMinutes)
        .then((sent) => {
          if (!sent) {
            this.logger.warn(`Signup verification OTP not delivered to ${email} — code still valid`);
          }
        })
        .catch((err) =>
          this.logger.warn(`Signup verification email failed for ${email}: ${(err as Error).message}`),
        );
    } catch (err) {
      this.logger.warn(`Signup verification OTP failed for ${email}: ${(err as Error).message}`);
    }
  }
}
