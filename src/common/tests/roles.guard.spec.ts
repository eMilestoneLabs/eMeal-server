/**
 * roles.guard.spec.ts — Security regression: role guard enforcement.
 *
 * Locks RolesGuard behaviour so role leakage / privilege escalation regressions
 * fail CI:
 *   - no @Roles() metadata  -> any authenticated user allowed
 *   - wrong role            -> ForbiddenException
 *   - correct role          -> allowed
 *   - missing request.user  -> ForbiddenException
 *   - Pass 10 (FR-MEMX-007): current DB role wins over a stale JWT role
 *
 * Pure unit test — Reflector and ExecutionContext are mocked, no Nest bootstrap.
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../guards/roles.guard';
import { ADMIN_ROLES } from '../decorators/roles.decorator';

function makeContext(user: any): any {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => null,
    getClass: () => null,
  };
}

function makeReflector(requiredRoles: string[] | undefined): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(requiredRoles) } as any;
}

/** Guard with no DB/Redis (falls back to the JWT role — legacy behaviour). */
function makeGuard(roles: string[] | undefined): RolesGuard {
  return new RolesGuard(makeReflector(roles), null, null);
}

describe('RolesGuard', () => {
  it('allows any authenticated user when no @Roles() metadata present', async () => {
    const guard = makeGuard(undefined);
    const ctx = makeContext({ sub: 'u1', role: 'student', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows when empty roles array', async () => {
    const guard = makeGuard([]);
    const ctx = makeContext({ sub: 'u1', role: 'student', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows a user holding a required admin role', async () => {
    const guard = makeGuard([...ADMIN_ROLES]);
    const ctx = makeContext({ sub: 'u1', role: 'hostelAdmin', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('forbids a student from an admin-only route (role leakage guard)', async () => {
    const guard = makeGuard([...ADMIN_ROLES]);
    const ctx = makeContext({ sub: 'u1', role: 'student', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('forbids when no authenticated user is present', async () => {
    const guard = makeGuard([...ADMIN_ROLES]);
    const ctx = makeContext(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // ── Pass 10 — FR-MEMX-007: role changes take effect immediately ──────────

  it('a DEMOTED admin is refused even with a stale admin JWT', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ role: 'student' }), // demoted
      },
    };
    const redis: any = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    const guard = new RolesGuard(makeReflector([...ADMIN_ROLES]), prisma, redis);
    const ctx = makeContext({ sub: 'u1', role: 'hostelAdmin', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' } }),
    );
  });

  it('a PROMOTED member passes immediately; the verified role is cached', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ role: 'hostelAdmin' }),
      },
    };
    const redis: any = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    const guard = new RolesGuard(makeReflector([...ADMIN_ROLES]), prisma, redis);
    const ctx = makeContext({ sub: 'u1', role: 'student', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith('auth:role:u1', 'hostelAdmin', 60);
  });

  it('DB unavailability falls back to the JWT role (no admin lockout)', async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockRejectedValue(new Error('db down')) },
    };
    const redis: any = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    const guard = new RolesGuard(makeReflector([...ADMIN_ROLES]), prisma, redis);
    const ctx = makeContext({ sub: 'u1', role: 'hostelAdmin', organizationId: 'o1' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
