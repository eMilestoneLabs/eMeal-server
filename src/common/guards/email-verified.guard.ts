import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * SRS Module 03 ACC-005 (survey Q1/Q19) — email verification is required to
 * PARTICIPATE: marking attendance, preference selection (rides marking),
 * guest booking, correction requests and vacation requests are blocked for
 * unverified accounts. Read-only browsing stays open, and existing
 * history/billing is untouched — the member simply cannot create new
 * participation writes until they verify.
 *
 * The client shows a guided "Verify your email" flow on this error — the
 * message wording is part of that contract.
 *
 * Enforcement is env-toggleable (EMAIL_VERIFICATION_REQUIRED, default ON)
 * purely as an emergency rollback lever.
 */
// Perf (2026-07-19): in-process cache of the POSITIVE answer only. A verified
// account stays verified except when the member changes their email (which
// resets emailVerifiedAt) — the TTL bounds that rare window to ≤60s, while
// every hot participation write skips the per-request DB round-trip.
// Unverified users are NEVER cached, so completing verification unblocks
// instantly. Env EMAIL_VERIFIED_CACHE_TTL_MS (0 = legacy per-hit query).
// Bounded: whole-map clear on overflow — O(1), self-healing.
const VERIFIED_CACHE_TTL_MS = parseInt(
  process.env.EMAIL_VERIFIED_CACHE_TTL_MS ?? '60000',
  10,
);
const VERIFIED_CACHE_MAX_ENTRIES = 10000;

@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  /** userId → cache expiry (ms epoch). Presence = verified. */
  private readonly verifiedUntil = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const enforced =
      (process.env.EMAIL_VERIFICATION_REQUIRED ?? 'true') !== 'false';
    if (!enforced) return true;

    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.sub;
    if (!userId) return true; // JwtAuthGuard owns authentication

    if (VERIFIED_CACHE_TTL_MS > 0) {
      const exp = this.verifiedUntil.get(userId);
      if (exp && exp > Date.now()) return true;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerifiedAt: true },
    });
    if (user?.emailVerifiedAt) {
      if (VERIFIED_CACHE_TTL_MS > 0) {
        if (this.verifiedUntil.size >= VERIFIED_CACHE_MAX_ENTRIES) {
          this.verifiedUntil.clear();
        }
        this.verifiedUntil.set(userId, Date.now() + VERIFIED_CACHE_TTL_MS);
      }
      return true;
    }

    throw new ForbiddenException({
      message:
        'Please verify your email to participate. Verification is required before marking attendance, booking guests, or sending requests.',
      code: 'EMAIL_VERIFICATION_REQUIRED',
      errors: { email: 'Email not verified' },
    });
  }
}
