/**
 * system-none.util.ts — ISSUE-005 / ISSUE-002 (Live-Test-13).
 *
 * SINGLE SOURCE OF TRUTH for the system "None" preference.
 *
 * "None" means: **"I am attending this meal but I do not want any optional
 * preference item."** It is system-generated — admins never create, edit,
 * delete, reorder, price or quantify it, and it never counts against the
 * admin-configurable option cap.
 *
 * ## Two storage keys, one meaning (deliberate — do NOT migrate)
 * Standalone (flat) preferences store `'none'`; Preference Groups store
 * `'__none__'`. Both are already persisted across attendance, guests,
 * corrections, billing, reports, exports, offline caches and sync queues.
 * Rewriting them buys nothing a user can see and risks every one of those
 * paths, so instead **every validator, counter and aggregator calls
 * [isSystemNonePreference] rather than comparing raw strings**.
 *
 * ## NULL is also None (read-time only)
 * A PRESENT record with no preference is semantically identical to an explicit
 * None pick — the member/guest is attending and wants no optional item. Such
 * rows exist only from legacy data, imports, and guests booked while
 * "Require a preference per guest" was OFF; every live write path is now gated
 * (auto-attendance and opt-out are mutually exclusive with preferences, and
 * manual member/admin/guest marking all require a pick). [normalizePreferenceKey]
 * folds NULL into the flat None key **at read time only** — stored rows are
 * never modified — so `visible preferences + internal None == total present`
 * holds for historical dates without any data migration.
 *
 * Mirrors the Flutter side's `MealPreferenceOption.isSystemNone`.
 */

/** Storage key used by STANDALONE (flat) preferences. */
export const SYSTEM_NONE_FLAT_KEY = 'none';

/** Storage key used by PREFERENCE GROUP options. */
export const SYSTEM_NONE_GROUP_KEY = '__none__';

/** Display label. The internal key is never shown to the user. */
export const SYSTEM_NONE_LABEL = 'None';

/**
 * True when a preference value is the system "None" — in EITHER storage form.
 * Case- and whitespace-tolerant so every call site shares one rule.
 *
 * NOTE: null/undefined return FALSE here. "Is this value None?" and "does this
 * record count as None?" are different questions — use [normalizePreferenceKey]
 * for the latter, so a missing preference is never mistaken for an explicit
 * pick by validation code that must reject unknown tags.
 */
export function isSystemNonePreference(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === SYSTEM_NONE_FLAT_KEY || v === SYSTEM_NONE_GROUP_KEY;
}

/**
 * Read-time bucket key for a PRESENT record's preference.
 *
 * NULL/blank → the flat None key, so legacy rows and preference-optional guest
 * bookings land in the hidden None tally instead of vanishing from the
 * breakdown (which is what made the Kitchen Summary show a permanent red
 * "data mismatch"). Both None spellings collapse to one key so the dashboard
 * never splits the tally in two. Real tags pass through untouched.
 *
 * Callers must only apply this to records that COUNT toward the served
 * headcount (status = present) — an absent row has no preference by design and
 * must not be folded into None.
 */
export function normalizePreferenceKey(
  value: string | null | undefined,
): string {
  if (!value || !value.trim()) return SYSTEM_NONE_FLAT_KEY;
  return isSystemNonePreference(value) ? SYSTEM_NONE_FLAT_KEY : value;
}
