import type { RedisService } from '../../redis/redis.service';

/**
 * Cross-worker auth-cache invalidation (2026-07-19) — channel contract for
 * the RedisService invalidation bus.
 *
 * The RolesGuard L1 (5s) and EmailVerifiedGuard positive cache (60s) are
 * per-worker in-process maps. TTLs bound their staleness; this bus makes
 * propagation INSTANT (~1-2ms) when an auth-relevant fact changes: the
 * mutation site calls [invalidateUserAuthCaches], every worker's guard drops
 * its entry on the message. TTLs stay in place as the safety net — losing a
 * message can never do worse than the pre-bus behavior.
 *
 * NOTE (audited 2026-07-19): today the codebase has NO endpoint that mutates
 * User.role, and an email change does not reset emailVerifiedAt — so these
 * staleness windows currently cannot occur at all. The bus is wired now so
 * any FUTURE role-change / re-verification feature is coherent by default:
 * its author only needs to call [invalidateUserAuthCaches].
 */
export const INVALIDATION_CHANNELS = {
  /** Payload: userId — RolesGuard drops its L1 entry for this user. */
  role: 'inval:v1:role',
  /** Payload: userId — EmailVerifiedGuard drops its positive entry. */
  emailVerified: 'inval:v1:everify',
} as const;

/**
 * Drop every auth-related cache for [userId] across ALL workers: the shared
 * Redis role key (L2) plus, via the bus, each worker's in-process L1 entries.
 * Fire-and-forget safe; every step degrades to TTL behavior on failure.
 */
export async function invalidateUserAuthCaches(
  redis: RedisService | null | undefined,
  userId: string,
): Promise<void> {
  if (!redis) return;
  // L2 first so any worker that misses its L1 re-reads fresh truth.
  await redis.del?.(`auth:role:${userId}`);
  await redis.publishInvalidation?.(INVALIDATION_CHANNELS.role, userId);
  await redis.publishInvalidation?.(
    INVALIDATION_CHANNELS.emailVerified,
    userId,
  );
}
