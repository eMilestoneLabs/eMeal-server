/**
 * member-settings.util.ts — the ONE place the per-group member settings rule
 * lives (group-scoped vacation + auto-attendance).
 *
 * Both settings used to live only on `User`, so one toggle governed every group
 * a member belonged to. `GroupMember.isVacationMode` / `.isDefaultAttendance`
 * now hold the per-group value, and the effective value everywhere is:
 *
 *     effective = member value ?? user value
 *
 * NULL is load-bearing: it means "inherit the user-level flag". Every row that
 * existed before the migration is NULL, so the effective value is identical to
 * the previous behaviour until something explicitly writes a per-group value —
 * and the org-level / admin-forced GLOBAL toggles keep working through exactly
 * that inheritance.
 *
 * Two helpers, because the rule has to hold in two different places and a
 * hand-written second copy is how they drift apart:
 *   • {@link resolveMemberFlag}     — in memory, on rows already fetched.
 *   • {@link memberFlagWhere}       — inside a Prisma `where`, when the filter
 *                                     must run in the database.
 *
 * Plain functions over plain values — no DI, no Prisma import, no module
 * wiring, so services, repositories and workers all adopt it unchanged.
 */

/** The user-level fallback shape every caller already selects. */
export interface UserFlagSource {
  isVacationMode?: boolean | null;
  isDefaultAttendance?: boolean | null;
}

/** The per-group override shape, as stored on `GroupMember`. */
export interface MemberFlagSource {
  isVacationMode?: boolean | null;
  isDefaultAttendance?: boolean | null;
}

/** Settings that carry a per-group override. */
export type MemberSettingKey = 'isVacationMode' | 'isDefaultAttendance';

/**
 * Effective value of `key` for one (group, member) pair.
 *
 * `??` — NOT `||` — is the whole point: an explicit per-group `false` must beat
 * an inherited `true` (that is how a per-group return-early, or opting out of
 * auto-attendance in a single group, works). `||` would silently fall through
 * to the user flag and re-enable the setting the member just switched off.
 *
 * Missing rows resolve to `false`, matching the `?? false` every call site
 * already applied to the user flag.
 */
export function resolveMemberFlag(
  member: MemberFlagSource | null | undefined,
  user: UserFlagSource | null | undefined,
  key: MemberSettingKey,
): boolean {
  const override = member?.[key];
  if (override !== null && override !== undefined) return override;
  return user?.[key] === true;
}

/**
 * Prisma `where` fragment selecting `GroupMember` rows whose EFFECTIVE `key`
 * equals `expected`. Spread it into a `groupMember` filter:
 *
 *     where: { groupId, status: 'active', ...memberFlagWhere('isDefaultAttendance', true) }
 *
 * Always a POSITIVE `OR` of the two ways a row can qualify — never a `NOT`
 * wrapper around the opposite condition. In SQL `NOT(NULL)` is `NULL`, not
 * `TRUE`, so a negated filter silently drops every member still inheriting the
 * user value. The fail direction is expensive: dropped members lose their meal
 * reminders, then get neutralized or auto-marked by the close sweep, which
 * changes what they are billed. Keeping the shape positive makes that class of
 * bug unrepresentable.
 *
 * The generated predicate is
 *   (member.<key> = expected) OR (member.<key> IS NULL AND user.<key> = expected)
 * which still resolves through the existing groupId / userId / status indexes —
 * these columns are only ever an additional filter on an already-selected set,
 * never the driving lookup.
 */
export function memberFlagWhere(
  key: MemberSettingKey,
  expected: boolean,
): { OR: Array<Record<string, unknown>> } {
  return {
    OR: [
      { [key]: expected },
      { [key]: null, user: { [key]: expected } },
    ],
  };
}
