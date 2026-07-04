/**
 * refresh-grace.spec.ts — rotation-reuse grace window (mobile logout fix).
 *
 * Strict refresh rotation nukes the whole session family when a revoked
 * token reappears. On mobile that fires constantly as a FALSE positive:
 * the rotation response is lost (network drop / OS app-kill) and the phone
 * retries with the just-revoked token. These tests lock the fix:
 *   - just-rotated token + grace key present → NEW pair, family survives
 *   - revoked token with NO grace key (real theft) → family nuked, 401
 *   - grace key is written with the configured TTL at rotation time
 *
 * Successor-usage rescue (the "any elapsed time" golden path) is locked too:
 *   - revoked token whose successor was NEVER used → rescued in-family,
 *     undelivered successor retired — even hours later (app-kill case)
 *   - revoked token whose successor WAS used (genuine fork) → family nuked
 *   - rotation links predecessor → successor via markRefreshTokenRotated
 *
 * AuthService is constructed directly with plain mocks (no Nest bootstrap)
 * — same pattern as roles.guard.spec.
 */
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthService } from '../auth.service';

const RAW_TOKEN = 'raw.refresh.token';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

function makeService(overrides: {
  tokenRecord?: any;
  successor?: any;
  graceActive?: boolean;
  config?: Record<string, unknown>;
}) {
  const usersRepo: any = {
    findById: jest.fn().mockResolvedValue({
      id: 'usr_01',
      isActive: true,
      role: 'student',
      organizationId: 'org_01',
      email: 'a@b.c',
      phone: null,
      name: 'A',
      avatarUrl: null,
      gender: null,
      age: null,
      isVacationMode: false,
      remindersEnabled: true,
      loginPreference: 'email',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
  };
  const authRepo: any = {
    findRefreshTokenByHash: jest
      .fn()
      .mockResolvedValue(overrides.tokenRecord ?? null),
    findRefreshTokenById: jest
      .fn()
      .mockResolvedValue(overrides.successor ?? null),
    revokeAllTokensByFamily: jest.fn().mockResolvedValue(undefined),
    revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
    markRefreshTokenRotated: jest.fn().mockResolvedValue(undefined),
    createRefreshToken: jest.fn().mockResolvedValue({ id: 'tok_new' }),
  };
  const jwtService: any = {
    verify: jest.fn().mockReturnValue({
      sub: 'usr_01',
      family: 'fam_01',
      organizationId: 'org_01',
      role: 'student',
    }),
    sign: jest.fn().mockReturnValue('new.signed.token'),
  };
  const config: any = {
    get: jest.fn((key: string) => {
      const table: Record<string, unknown> = {
        'jwt.refreshSecret': 'secret',
        'jwt.accessExpiresIn': 900,
        'jwt.refreshExpiresIn': 604800,
        'auth.refreshGraceSeconds': 90,
        ...(overrides.config ?? {}),
      };
      return table[key];
    }),
  };
  const redis: any = {
    isFamilyRevoked: jest.fn().mockResolvedValue(false),
    revokeFamily: jest.fn().mockResolvedValue(undefined),
    addTokenToFamily: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(overrides.graceActive ?? false),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AuthService(
    usersRepo,
    authRepo,
    {} as any, // prisma — untouched by refreshTokens
    jwtService,
    config,
    redis,
    { log: jest.fn() } as any, // audit
    {} as any, // mailer
    {} as any, // sms
  );
  return { service, authRepo, redis, usersRepo };
}

describe('AuthService.refreshTokens — rotation-reuse grace', () => {
  it('a just-rotated token retried WITHIN grace gets a new pair — family survives', async () => {
    const { service, authRepo, redis } = makeService({
      tokenRecord: { id: 'tok_old', isRevoked: true, expiresAt: new Date(Date.now() + 1000) },
      graceActive: true,
    });

    const result: any = await service.refreshTokens(RAW_TOKEN, {});
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    // The family must NOT be nuked.
    expect(authRepo.revokeAllTokensByFamily).not.toHaveBeenCalled();
    expect(redis.revokeFamily).not.toHaveBeenCalled();
  });

  it('grace also covers a token row already DELETED by cleanup', async () => {
    const { service, authRepo } = makeService({
      tokenRecord: null,
      graceActive: true,
    });
    const result: any = await service.refreshTokens(RAW_TOKEN, {});
    expect(result.accessToken).toBeDefined();
    expect(authRepo.revokeAllTokensByFamily).not.toHaveBeenCalled();
  });

  it('a revoked token WITHOUT grace (real theft) still nukes the family with 401', async () => {
    const { service, authRepo, redis } = makeService({
      tokenRecord: { id: 'tok_old', isRevoked: true, expiresAt: new Date(Date.now() + 1000) },
      graceActive: false,
    });
    await expect(service.refreshTokens(RAW_TOKEN, {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authRepo.revokeAllTokensByFamily).toHaveBeenCalledWith('fam_01');
    expect(redis.revokeFamily).toHaveBeenCalledWith('fam_01');
  });

  it('a normal rotation opens the grace window with the configured TTL', async () => {
    const { service, redis } = makeService({
      tokenRecord: {
        id: 'tok_live',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await service.refreshTokens(RAW_TOKEN, {});
    expect(redis.set).toHaveBeenCalledWith(
      `auth:refresh:grace:${TOKEN_HASH}`,
      '1',
      90,
    );
  });

  it('a normal rotation links predecessor → successor (revoke + usedAt + replacedById)', async () => {
    const { service, authRepo } = makeService({
      tokenRecord: {
        id: 'tok_live',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await service.refreshTokens(RAW_TOKEN, {});
    expect(authRepo.markRefreshTokenRotated).toHaveBeenCalledWith(
      'tok_live',
      'tok_new',
    );
  });
});

describe('AuthService.refreshTokens — successor-usage rescue (any elapsed time)', () => {
  const revokedToken = () => ({
    id: 'tok_old',
    isRevoked: true,
    replacedById: 'tok_succ',
    expiresAt: new Date(Date.now() + 86_400_000), // within its 7-day life
  });

  it('revoked token whose successor was NEVER used → rescued in-family, successor retired (app-kill case, hours later)', async () => {
    const { service, authRepo, redis } = makeService({
      tokenRecord: revokedToken(),
      successor: { id: 'tok_succ', usedAt: null, isRevoked: false },
      graceActive: false, // well outside the 90s Redis window
    });

    const result: any = await service.refreshTokens(RAW_TOKEN, {});
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    // The undelivered successor must be retired so nobody else can redeem it.
    expect(authRepo.revokeRefreshToken).toHaveBeenCalledWith('tok_succ');
    // Family survives.
    expect(authRepo.revokeAllTokensByFamily).not.toHaveBeenCalled();
    expect(redis.revokeFamily).not.toHaveBeenCalled();
  });

  it('revoked token whose successor WAS used (genuine fork = theft) → family nuked with 401', async () => {
    const { service, authRepo, redis } = makeService({
      tokenRecord: revokedToken(),
      successor: { id: 'tok_succ', usedAt: new Date(), isRevoked: true },
      graceActive: false,
    });
    await expect(service.refreshTokens(RAW_TOKEN, {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authRepo.revokeAllTokensByFamily).toHaveBeenCalledWith('fam_01');
    expect(redis.revokeFamily).toHaveBeenCalledWith('fam_01');
  });

  it('revoked token whose successor was already retired by a rescue → nuked (interception signal)', async () => {
    const { service, authRepo } = makeService({
      tokenRecord: revokedToken(),
      successor: { id: 'tok_succ', usedAt: null, isRevoked: true },
      graceActive: false,
    });
    await expect(service.refreshTokens(RAW_TOKEN, {})).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authRepo.revokeAllTokensByFamily).toHaveBeenCalledWith('fam_01');
  });

  it('an EXPIRED revoked token is never rescued (7-day inactivity contract holds)', async () => {
    const { service, authRepo } = makeService({
      tokenRecord: {
        id: 'tok_old',
        isRevoked: true,
        replacedById: 'tok_succ',
        expiresAt: new Date(Date.now() - 1000), // past its 7-day life
      },
      successor: { id: 'tok_succ', usedAt: null, isRevoked: false },
      graceActive: false,
    });
    await expect(service.refreshTokens(RAW_TOKEN, {})).rejects.toThrow(
      UnauthorizedException,
    );
    // Falls through to the theft branch — no rescue, no new pair.
    expect(authRepo.createRefreshToken).not.toHaveBeenCalled();
  });
});
