/**
 * roles.guard.spec.ts — Security regression: role guard enforcement.
 *
 * Locks RolesGuard behaviour so role leakage / privilege escalation regressions
 * fail CI:
 *   - no @Roles() metadata  -> any authenticated user allowed
 *   - wrong role            -> ForbiddenException
 *   - correct role          -> allowed
 *   - missing request.user  -> ForbiddenException
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

describe('RolesGuard', () => {
  it('allows any authenticated user when no @Roles() metadata present', () => {
    const guard = new RolesGuard(makeReflector(undefined));
    const ctx = makeContext({ sub: 'u1', role: 'student', organizationId: 'o1' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when empty roles array', () => {
    const guard = new RolesGuard(makeReflector([]));
    const ctx = makeContext({ sub: 'u1', role: 'student', organizationId: 'o1' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows a user holding a required admin role', () => {
    const guard = new RolesGuard(makeReflector([...ADMIN_ROLES]));
    const ctx = makeContext({ sub: 'u1', role: 'hostelAdmin', organizationId: 'o1' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('forbids a student from an admin-only route (role leakage guard)', () => {
    const guard = new RolesGuard(makeReflector([...ADMIN_ROLES]));
    const ctx = makeContext({ sub: 'u1', role: 'student', organizationId: 'o1' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('forbids when no authenticated user is present', () => {
    const guard = new RolesGuard(makeReflector([...ADMIN_ROLES]));
    const ctx = makeContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
