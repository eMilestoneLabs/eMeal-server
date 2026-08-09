/**
 * published-day.util.ts — Live-Test-9 ISSUE-002/003.
 *
 * SINGLE SOURCE OF TRUTH for "what did the PUBLISHED schedule say about this
 * group on this calendar date?".
 *
 * Why this exists: the student-facing display path (/meals/today, weekly menu)
 * reads the frozen `publishedSnapshot` (preserved while the admin edits a
 * draft — `publishedAt != null` is the visibility gate, `isPublished` is only
 * the admin draft flag). But enforcement paths (attendance marking,
 * corrections, guest booking, the system-default / auto-attendance / reminder
 * sweeps) each re-implemented the lookup against LIVE `scheduleEntry` rows
 * gated on `isPublished: true`. The moment an admin edit reverted a schedule
 * to draft, those paths silently diverged from what members were shown:
 * stale weeks, master-meal preference sets the published day had disabled,
 * sweeps skipping planner groups entirely. Every consumer now resolves the
 * day through this one helper, so display == enforcement by construction.
 *
 * Resolution order (identical to the /meals/today overlay semantics):
 *   1. The published week containing the date → entries matching the exact
 *      date (true date-based / Day-Wise planning).
 *   2. Fallback: the most recent published schedule → entries matching the
 *      weekday (SCH-011 recurring weekly continuation).
 *   2b. DAY-WISE GROUPS ONLY (Live-Test-15 ISSUE-1): the latest published
 *      calendar day strictly before the date — the rolling Day-Wise
 *      carry-forward baseline. Never reached by Weekly groups.
 * Rows published before the snapshot column existed (null snapshot) fall back
 * to their live entries — safe, because before snapshots a published row
 * could not also hold an unsynced draft (live == published).
 *
 * Prisma is passed in (same pattern as vacation-coverage.util) so workers,
 * repositories and services can all share it without new DI wiring.
 */

/**
 * P-01 (Live-Test-15) — CONFIGURATION-FROZEN MARKER.
 *
 * `configurationFrozen: true` means this published entry carries the COMPLETE
 * effective configuration resolved at publish time — including the preference
 * block below — so no reader ever needs live Master state for it.
 *
 * Entries WITHOUT the marker predate full snapshotting: no earlier build ever
 * froze preference configuration, and there is NO authoritative historical
 * source from which it could be recovered (audit logs store deltas only;
 * AttendancePreferenceSelection records what members CHOSE, never what was
 * OFFERED). Those entries therefore keep resolving exactly as they always
 * have — they are never reconstructed from today's Master, which would
 * fabricate historical Published truth. Only an explicit admin
 * Publish/Republish freezes a schedule's configuration.
 */

/** One frozen preference option — mirrors PreferenceOption at publish time. */
export interface PublishedPreferenceOption {
  /** PreferenceOption row id — the Flutter option model parses it. */
  id: string;
  key: string;
  label: string;
  emoji: string | null;
  color: string | null;
  isVeg: boolean;
  priceDelta: number;
  minQty: number;
  maxQty: number;
  order: number;
}

/** One frozen preference group — mirrors EffectivePreferenceGroup at publish time. */
export interface PublishedPreferenceGroup {
  id: string;
  label: string;
  /** Student-facing helper text — part of the rendered payload. */
  description: string | null;
  order: number;
  selectionType: string;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  quantityEnabled: boolean;
  vegOnly: boolean;
  visibleWhen: { groupId: string; optionKey: string } | null;
  options: PublishedPreferenceOption[];
}

/**
 * The complete effective preference configuration of ONE published meal-day,
 * resolved at publish time (master ⊕ per-day override) and frozen. Readers use
 * this INSTEAD of re-resolving against live master state.
 */
export interface PublishedPreferenceSnapshot {
  /** Effective per-day on/off (entry override ?? master meal flag). */
  enabled: boolean;
  /** 'group' = ≥1 active preference group bound; 'standalone' = flat tags. */
  mode: 'group' | 'standalone';
  /** Flat standalone tags (empty in group mode or when disabled). */
  tags: string[];
  /** Fully resolved groups incl. options, pick rules and price deltas. */
  groups: PublishedPreferenceGroup[];
}

/** Frozen master-meal metadata captured inside the published snapshot. */
export interface PublishedDayMealSnapshot {
  slotKey: string;
  name: string;
  displayName: string | null;
  order: number;
  menuItems: string[];
  imageUrl: string | null;
  description: string | null;
  price: number | null;
  attendanceWindowOpen: string | null;
  attendanceWindowClose: string | null;
}

/** One published day entry, normalized to a stable shape. */
export interface PublishedDayEntry {
  mealId: string;
  openTime: string | null;
  closeTime: string | null;
  mealName: string | null;
  description: string | null;
  imageUrl: string | null;
  preferencesEnabled: boolean | null;
  enabledPreferences: string[];
  enabledPreferenceGroupIds: string[];
  menuItems: string[];
  price: number | null;
  /** Master-meal metadata frozen at publish time (null on legacy live rows without join). */
  meal: PublishedDayMealSnapshot | null;
  /**
   * P-01: true when this entry carries the COMPLETE effective configuration
   * frozen at publish time. Readers MUST branch on this:
   *   true  → resolve every published-effective field from the snapshot;
   *   false → predates full snapshotting, keep the historical resolution.
   */
  configurationFrozen: boolean;
  /** Frozen effective preference configuration — null when not frozen. */
  preference: PublishedPreferenceSnapshot | null;
  /**
   * P-01: the planner mode this day was PUBLISHED in. Recorded alongside the
   * frozen configuration so the Day-Wise carry-forward is decided by the
   * PUBLISHED schedule rather
   * than the group's LIVE mode flag — the flag flips the moment an admin
   * switches modes, i.e. BEFORE the new mode is published, and letting it
   * drive published resolution is the same leak P-01 exists to close.
   * Null on entries that predate the freeze, which keep the live-flag path.
   */
  plannerMode: 'WEEKLY' | 'DAY_WISE' | null;
}

/** Meal join used for legacy (null-snapshot) rows — mirrors snapshotFromEntries. */
const LEGACY_MEAL_SELECT = {
  slotKey: true,
  name: true,
  displayName: true,
  order: true,
  menuItems: true,
  imageUrl: true,
  description: true,
  price: true,
  attendanceWindowOpen: true,
  attendanceWindowClose: true,
} as const;

type PrismaLike = {
  mealSchedule: {
    findFirst: (args: unknown) => Promise<any>;
  };
  /** Optional so partial test doubles (and legacy callers) still work: an
   *  absent delegate simply skips the Day-Wise carry-forward step. */
  group?: {
    findFirst: (args: unknown) => Promise<any>;
  };
};

function normalizeMeal(raw: any): PublishedDayMealSnapshot | null {
  if (!raw) return null;
  return {
    slotKey: raw.slotKey,
    name: raw.name,
    displayName: raw.displayName ?? null,
    order: raw.order ?? 0,
    menuItems: raw.menuItems ?? [],
    imageUrl: raw.imageUrl ?? null,
    description: raw.description ?? null,
    price: raw.price ?? null,
    attendanceWindowOpen: raw.attendanceWindowOpen ?? null,
    attendanceWindowClose: raw.attendanceWindowClose ?? null,
  };
}

function normalizeEntry(raw: any): PublishedDayEntry & {
  dayOfWeek: number;
  dateMs: number | null;
} {
  const d = raw.date ? new Date(raw.date) : null;
  return {
    mealId: raw.mealId,
    dayOfWeek: raw.dayOfWeek ?? -1,
    dateMs: d && !Number.isNaN(d.getTime()) ? d.getTime() : null,
    openTime: raw.openTime ?? null,
    closeTime: raw.closeTime ?? null,
    mealName: raw.mealName ?? null,
    description: raw.description ?? null,
    imageUrl: raw.imageUrl ?? null,
    preferencesEnabled: raw.preferencesEnabled ?? null,
    enabledPreferences: raw.enabledPreferences ?? [],
    enabledPreferenceGroupIds: raw.enabledPreferenceGroupIds ?? [],
    menuItems: raw.menuItems ?? [],
    price: raw.price ?? null,
    meal: normalizeMeal(raw.meal),
    // P-01: the entry is self-describing.
    // Both conditions are required — the marker alone must never promote an
    // entry whose configuration block failed to resolve.
    configurationFrozen: raw.configurationFrozen === true && !!raw.preference,
    preference: raw.preference ?? null,
    plannerMode:
      raw.plannerMode === 'WEEKLY' || raw.plannerMode === 'DAY_WISE'
        ? raw.plannerMode
        : null,
  };
}

/** Published entries of a schedule row: frozen snapshot first, legacy live fallback. */
function publishedEntriesOf(row: any): Array<ReturnType<typeof normalizeEntry>> {
  if (!row) return [];
  const snap = row.publishedSnapshot;
  if (Array.isArray(snap) && snap.length > 0) return snap.map(normalizeEntry);
  return (row.entries ?? []).map(normalizeEntry);
}

/**
 * Live-Test-15 ISSUE-1 (user-locked) — DAY-WISE CARRY-FORWARD.
 *
 * Pure selector: from [candidates], return every entry belonging to the LATEST
 * published calendar date STRICTLY BEFORE [beforeMs]. That day is the group's
 * current carry-forward baseline:
 *
 *   "NO NEW PUBLISHED CHANGE → LAST EFFECTIVE PUBLISHED DAY CONTINUES FORWARD.
 *    NEW PUBLISHED CHANGE  → THAT DAY BECOMES THE NEW BASELINE."
 *
 * Entries with no resolvable date (legacy weekday-only rows) are ignored — they
 * are already served by the weekday-recurring fallback. No query, no I/O; the
 * caller supplies rows it has already fetched.
 */
function carryForwardEntries(
  candidates: ReadonlyArray<ReturnType<typeof normalizeEntry>>,
  beforeMs: number,
): Array<ReturnType<typeof normalizeEntry>> {
  let baselineMs: number | null = null;
  for (const e of candidates) {
    if (e.dateMs === null || e.dateMs >= beforeMs) continue;
    if (baselineMs === null || e.dateMs > baselineMs) baselineMs = e.dateMs;
  }
  if (baselineMs === null) return [];
  return candidates.filter((e) => e.dateMs === baselineMs);
}

/**
 * Resolve the published day entries for (group, date) as Map<mealId, entry>.
 * Empty map = no published schedule governs the date (caller falls back to
 * master meal config — unchanged behaviour for non-planner groups).
 *
 * dateStr is the org-local calendar date, YYYY-MM-DD.
 */
export async function resolvePublishedDayEntries(
  prisma: PrismaLike,
  params: {
    groupId: string;
    organizationId: string;
    dateStr: string;
    /**
     * OPTIONAL, purely additive: the group's planner mode when the CALLER
     * already holds it. Supplied ⇒ the miss-path group lookup below is skipped
     * entirely. Omitted ⇒ identical behaviour to before this parameter existed,
     * so every existing call site is unaffected.
     *
     * Worth passing wherever the group row is already in hand — most of all in
     * the sweeps, which call this once PER GROUP inside a loop, so a redundant
     * lookup there multiplies by the number of groups in the org.
     */
    dayWiseMealsEnabled?: boolean | null;
  },
): Promise<Map<string, PublishedDayEntry>> {
  const { groupId, organizationId, dateStr } = params;
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  const dateUtc = new Date(Date.UTC(yy, mm - 1, dd));
  const dow = (dateUtc.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  const weekStart = new Date(dateUtc.getTime() - dow * 86400000);

  const include = {
    entries: { include: { meal: { select: LEGACY_MEAL_SELECT } } },
  } as const;

  // 1) Exact published week (publishedAt gate — survives draft reverts).
  const weekRow = await prisma.mealSchedule.findFirst({
    where: { groupId, organizationId, weekStart, publishedAt: { not: null } },
    include,
  });
  let entries = publishedEntriesOf(weekRow).filter(
    (e) => e.dateMs === dateUtc.getTime(),
  );

  // 2) Fallback: most recent published schedule, matched by weekday (recurring)
  // — byte-identical to the /meals/today overlay's historical fallback.
  let latestRow: any = null;
  if (entries.length === 0) {
    latestRow = await prisma.mealSchedule.findFirst({
      where: { groupId, organizationId, publishedAt: { not: null } },
      orderBy: { weekStart: 'desc' },
      include,
    });
    entries = publishedEntriesOf(latestRow).filter((e) => e.dayOfWeek === dow);
  }

  // 2b) DAY-WISE CARRY-FORWARD (Live-Test-15 ISSUE-1, user-locked rule).
  //
  // Day-Wise mode publishes a ROLLING Today+Tomorrow window. Once the calendar
  // advances past the last published date the admin must NOT be forced to
  // re-publish merely to keep an unchanged menu running, so the day inherits
  // the latest effective PUBLISHED day before it. Publishing a new Tomorrow
  // automatically makes that day the new baseline for every later day.
  //
  // WEEKLY IS PROVABLY UNTOUCHED — this is gated on the group's Day-Wise flag
  // AND only reached when steps 1 and 2 both found nothing. A weekly day that
  // was deliberately published with no meals therefore stays empty, exactly as
  // before. Test doubles without the `group` relation optional-chain to
  // `undefined` ⇒ false ⇒ this step is skipped ⇒ legacy behaviour preserved.
  //
  // DRAFT WALL: reads `publishedSnapshot` only (via publishedEntriesOf), so an
  // unpublished Tomorrow edit can never become the carry-forward baseline.
  //
  // COST: reuses the two rows already loaded above — ZERO extra queries.
  // Both are considered because the baseline may sit in the target's own week
  // row (past-date reads) or in the most recent published week (the normal
  // rolling case).
  if (entries.length === 0) {
    // COST NOTE (measured against the real client, not assumed): this project
    // runs Prisma 5.10 WITHOUT the `relationJoins` preview feature, so a
    // relation `select` inside an `include` is executed as a SEPARATE QUERY,
    // never as a SQL JOIN. Carrying the group's planner mode on the include
    // above would therefore have added a round-trip to EVERY resolver call —
    // /meals/today, attendance marking, guest booking, vacation coverage and
    // four worker sweeps — breaking the one-wave read law (guidebook §3b).
    //
    // So the mode is read HERE instead: only after steps 1 and 2 both missed,
    // which is precisely the path that was about to fall back to the Master
    // template anyway. A Weekly group with a published day never reaches this
    // line, so the hot path costs exactly what it did before this feature.
    // Guard the METHOD, not just the delegate. Several callers (workers,
    // repositories, test doubles) pass a PARTIAL prisma-like object that
    // defines `group.findMany` but no `findFirst`; `prisma.group?.findFirst()`
    // would then throw "not a function" and take the whole sweep down with it.
    // An absent delegate simply skips the Day-Wise step — the same fail-safe
    // the rest of this resolver uses.
    // ORDER MATTERS. Resolve the ANSWER first, the MODE second. carryForward
    // reads only rows already in memory, and returns [] whenever no published
    // day precedes the target date — the case for every group that has never
    // published at all (attendance-only, brand-new, or simply not using the
    // planner). For those the mode cannot change the outcome, so asking the
    // database for it is pure waste on a read path shared by /meals/today,
    // attendance marking, guest booking, vacation coverage and the sweeps.
    const carried = carryForwardEntries(
      [...publishedEntriesOf(weekRow), ...publishedEntriesOf(latestRow)],
      dateUtc.getTime(),
    );
    if (carried.length > 0) {
      // ── P-01: the PUBLISHED mode decides, not the live group flag ─────────
      // `dayWiseMealsEnabled` flips when the admin SWITCHES modes, which is
      // BEFORE the new mode is published. Driving carry-forward from it meant
      // that switching Weekly → Day-Wise immediately resurrected meals onto a
      // published Weekly day the admin had deliberately left empty
      // (FR-MODE-032 holiday) — a published-schedule change caused by a mode
      // switch, exactly what the locked invariant forbids.
      //
      // A frozen snapshot records the mode it was published in, so the
      // decision is made from the published baseline itself. Bonus: it skips
      // the group lookup entirely (one query less on the miss path). Entries
      // without a recorded mode keep the live-flag behaviour verbatim.
      const publishedMode =
        carried.find((e) => e.plannerMode != null)?.plannerMode ?? null;
      if (publishedMode != null) {
        if (publishedMode === 'DAY_WISE') entries = carried;
      } else {
        // Caller already knows the mode → no query at all.
        let dayWise = params.dayWiseMealsEnabled === true;
        if (params.dayWiseMealsEnabled == null) {
          const canReadGroup = typeof prisma.group?.findFirst === 'function';
          const group = canReadGroup
            ? await prisma.group!.findFirst({
                where: { id: groupId, organizationId }, // org-scoped
                select: { dayWiseMealsEnabled: true },
              })
            : null;
          dayWise = group?.dayWiseMealsEnabled === true;
        }
        if (dayWise) entries = carried;
      }
    }
  }

  const map = new Map<string, PublishedDayEntry>();
  for (const e of entries) {
    const { dayOfWeek: _d, dateMs: _m, ...entry } = e;
    map.set(entry.mealId, entry);
  }
  return map;
}
