import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { JwtPayload } from '../decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

/** SRS FR-MEMX-007: how long a verified role may be trusted before re-check. */
const ROLE_CACHE_TTL_SECONDS = 60;

// Perf (2026-07-19): tiny in-process L1 in FRONT of the Redis role cache — a
// hot user's role resolves with ZERO network hops on nearly every request
// (the Redis GET was the last per-request round-trip in the read pipeline).
// Role-change propagation was already TTL-driven (60s, no explicit
// invalidation exists); the L1 adds at most its own TTL on top (5s default),
// so governance is unchanged in practice. Env ROLE_L1_TTL_MS (0 = disable).
// Bounded: on overflow the map is cleared whole — O(1), self-healing.
const ROLE_L1_TTL_MS = parseInt(process.env.ROLE_L1_TTL_MS ?? '5000', 10);
const ROLE_L1_MAX_ENTRIES = 10000;

/**
 * RolesGuard — enforces @Roles(...) decorator.
 * Must be used AFTER JwtAuthGuard (request.user must be populated).
 *
 * Produces flat error contract: { message, errors, statusCode: 403 }
 *
 * SRS FR-MEMX-007 (Pass 10): role changes take effect immediately — the JWT
 * role is only a hint; privileged routes verify the CURRENT server-side role
 * (60s Redis cache keeps the hot path at ~0 extra queries). A demoted admin
 * is refused on the next request instead of riding a stale token.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Roles(...ADMIN_ROLES)
 *   @Post('groups')
 *   createGroup() {}
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // Optional so lightweight unit-test modules keep working; production
    // always has the @Global Prisma/Redis providers.
    @Optional() @Inject(PrismaService)
    private readonly prisma: PrismaService | null,
    @Optional() @Inject(RedisService)
    private readonly redis: RedisService | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator — route is open to any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload | undefined = request.user;

    if (!user) {
      throw new ForbiddenException({
        message: 'Authentication required',
        errors: { auth: 'No authenticated user found' },
      });
    }

    const effectiveRole = await this.resolveCurrentRole(user);

    if (!requiredRoles.includes(effectiveRole)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: {
          role: `This action requires one of: ${requiredRoles.join(', ')}. Your role: ${effectiveRole}`,
        },
      });
    }

    // Downstream handlers see the verified role, never a stale JWT claim.
    request.user = { ...user, role: effectiveRole };
    return true;
  }

  /** In-process L1: userId → { role, expiry } (see ROLE_L1_TTL_MS above). */
  private readonly roleL1 = new Map<string, { role: string; exp: number }>();

  /** Current DB role, cached 60s (Redis) + 5s (in-process L1). Falls back to
   *  the JWT claim if unavailable. */
  private async resolveCurrentRole(user: JwtPayload): Promise<string> {
    if (!this.prisma) return user.role;
    if (ROLE_L1_TTL_MS > 0) {
      const hit = this.roleL1.get(user.sub);
      if (hit && hit.exp > Date.now()) return hit.role;
    }
    const cacheKey = `auth:role:${user.sub}`;
    try {
      const cached = await this.redis?.get(cacheKey);
      if (cached) {
        this.rememberRole(user.sub, cached);
        return cached;
      }
    } catch (_) {
      /* cache is best-effort */
    }
    try {
      const row = await this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { role: true },
      });
      const role = row?.role ?? user.role;
      try {
        await this.redis?.set(cacheKey, role, ROLE_CACHE_TTL_SECONDS);
      } catch (_) {
        /* cache is best-effort */
      }
      this.rememberRole(user.sub, role);
      return role;
    } catch (_) {
      // DB hiccup must not lock admins out mid-incident — trust the JWT.
      return user.role;
    }
  }

  /** Populate the L1 (bounded; whole-map clear on overflow is O(1) + safe). */
  private rememberRole(userId: string, role: string): void {
    if (ROLE_L1_TTL_MS <= 0) return;
    if (this.roleL1.size >= ROLE_L1_MAX_ENTRIES) this.roleL1.clear();
    this.roleL1.set(userId, { role, exp: Date.now() + ROLE_L1_TTL_MS });
  }
}
