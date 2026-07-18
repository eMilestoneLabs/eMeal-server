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
 * Rows published before the snapshot column existed (null snapshot) fall back
 * to their live entries — safe, because before snapshots a published row
 * could not also hold an unsynced draft (live == published).
 *
 * Prisma is passed in (same pattern as vacation-coverage.util) so workers,
 * repositories and services can all share it without new DI wiring.
 */

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
 * Resolve the published day entries for (group, date) as Map<mealId, entry>.
 * Empty map = no published schedule governs the date (caller falls back to
 * master meal config — unchanged behaviour for non-planner groups).
 *
 * dateStr is the org-local calendar date, YYYY-MM-DD.
 */
export async function resolvePublishedDayEntries(
  prisma: PrismaLike,
  params: { groupId: string; organizationId: string; dateStr: string },
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
  if (entries.length === 0) {
    const latest = await prisma.mealSchedule.findFirst({
      where: { groupId, organizationId, publishedAt: { not: null } },
      orderBy: { weekStart: 'desc' },
      include,
    });
    entries = publishedEntriesOf(latest).filter((e) => e.dayOfWeek === dow);
  }

  const map = new Map<string, PublishedDayEntry>();
  for (const e of entries) {
    const { dayOfWeek: _d, dateMs: _m, ...entry } = e;
    map.set(entry.mealId, entry);
  }
  return map;
}
