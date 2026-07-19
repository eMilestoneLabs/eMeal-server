import type { RedisService } from '../../../redis/redis.service';

/**
 * Perf (2026-07-19): shared Redis cache for GET /meals/today.
 *
 * The today bundle (meal list + preference bindings + planner overlay,
 * ~6 DB queries incl. a 3-level nested include) is IDENTICAL for every
 * member of a group on a given org-date — the student path and the admin
 * path both resolve includeDisabled=false, and every per-request field
 * (windowState / serverTime / orgClockMinutes / graceMinutes) is applied
 * AFTER the cache by withWindowMeta from the LIVE group row. So one member
 * warms the bundle for the whole group and every subsequent hit is a
 * single Redis GET.
 *
 * Coherence: every write that can change the bundle invalidates the
 * group's keys BEFORE returning (meal create/update/delete/reorder,
 * schedule draft/publish/revert/clone, meal-config update) — preference
 * group/option edits invalidate org-wide because one preference group can
 * bind to meals across many groups. The TTL (env
 * MEALS_TODAY_CACHE_TTL_SECONDS, default 45, 0 = cache off → byte-identical
 * legacy path) only bounds staleness if an invalidation site is ever
 * missed. Tenant isolation is untouched: the group 404 gate runs LIVE on
 * every request, before any cached byte is returned.
 */
export function todayMealsCacheKey(
  organizationId: string,
  groupId: string,
  dateKey: string,
): string {
  return `mt:v1:${organizationId}:${groupId}:${dateKey}`;
}

export function todayMealsCacheTtlSeconds(): number {
  const raw = parseInt(process.env.MEALS_TODAY_CACHE_TTL_SECONDS ?? '45', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Drop cached today-bundles. groupId omitted → org-wide (preference-group
 * edits). Fail-soft: a Redis outage degrades to TTL expiry, never a 500.
 */
export async function invalidateTodayMealsCache(
  redis: RedisService | null | undefined,
  organizationId: string,
  groupId?: string,
): Promise<void> {
  try {
    await redis?.deletePattern(
      `mt:v1:${organizationId}:${groupId ?? '*'}:*`,
    );
  } catch {
    /* best-effort — TTL bounds staleness */
  }
}
