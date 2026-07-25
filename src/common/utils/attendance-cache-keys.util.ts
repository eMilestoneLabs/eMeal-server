/**
 * attendance-cache-keys.util.ts — ISSUE-002 (Live-Test-13).
 *
 * Shared Redis key builders for the attendance read-caches.
 *
 * Why this exists: the meal-summary payload became dependent on the meal's
 * `preferencesEnabled` flag (PRESENT rows with no preference are folded into
 * the hidden system-None tally only on preference meals). The flag is NOT part
 * of the cache key, and toggling it does not touch attendance records — so
 * without an explicit invalidation the Kitchen Summary would keep serving the
 * previous fold for the whole TTL. The key builder therefore has to be
 * reachable from BOTH the writer (attendance) and the invalidator (meals)
 * without either feature importing the other's service.
 *
 * Key format is unchanged from the original private helper — existing cached
 * entries stay addressable, and the attendance-change invalidation path keeps
 * matching byte-for-byte.
 */

/** Per (org, meal, date) admin meal-attendance summary. */
export function mealSummaryKey(
  orgId: string,
  mealId: string,
  date: string,
): string {
  return `attendance:meal:${orgId}:${mealId}:${date}`;
}
