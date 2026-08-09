/**
 * published-snapshot.util.ts — Live-Test-15 ISSUE-1 §5/§16.
 *
 * PROTECTS: "a DRAFT must never modify the current PUBLISHED schedule."
 *
 * ── The hazard ─────────────────────────────────────────────────────────────
 * `publishedSnapshot` was added AFTER the first releases. `scheduleFromSnapshot`
 * documents the consequence, verbatim: a published row whose snapshot is null
 * serves its LIVE `entries` as the published schedule, and "every week
 * published by an older build has a null snapshot, so production always took
 * this path".
 *
 * So on those legacy rows the draft layer and the published layer are the SAME
 * rows. Any write path that clears entries — a `replaceEntries` PATCH, a
 * planner mode conversion — therefore destroys the published schedule outright:
 * members lose the week with no publish, and the loss is irreversible.
 *
 * This is not hypothetical for Day-Wise. A Day-Wise draft holds exactly Today +
 * Tomorrow, so a replace-save against a legacy published WEEK would drop it
 * from seven published days to two, instantly, before the admin publishes
 * anything.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Freeze the current published view into the column that represents it FIRST,
 * inside the caller's transaction. This changes nothing about what members
 * see — the snapshot is built from exactly the rows that were being served —
 * it only stops the published view from depending on rows the draft is about
 * to replace. Idempotent: skipped for unpublished rows, for rows that already
 * have a snapshot, and for rows with no entries.
 *
 * Shared by `SchedulesRepository.update` and `PlannerModeConversionService` so
 * the guarantee cannot drift between the two write paths (DRY). Typed against
 * a minimal `tx` shape so it works with a Prisma transaction client, the
 * PrismaService itself, or a test double.
 */

/** Meal columns the frozen snapshot carries (mirrors the published-day reader). */
const SNAPSHOT_MEAL_SELECT = {
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

export interface SnapshotFreezeRow {
  id: string;
  publishedAt: Date | null;
  publishedSnapshot: unknown;
}

/** One frozen entry — the exact shape `published-day.util.normalizeEntry` reads. */
export function toSnapshotEntry(e: any): Record<string, unknown> {
  return {
    id: e.id,
    scheduleId: e.scheduleId,
    mealId: e.mealId,
    dayOfWeek: e.dayOfWeek,
    date: e.date instanceof Date ? e.date.toISOString() : e.date,
    openTime: e.openTime ?? null,
    closeTime: e.closeTime ?? null,
    mealName: e.mealName ?? null,
    notes: e.notes ?? null,
    description: e.description ?? null,
    imageUrl: e.imageUrl ?? null,
    preferencesEnabled: e.preferencesEnabled ?? null,
    enabledPreferences: e.enabledPreferences ?? [],
    enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
    menuItems: e.menuItems ?? [],
    price: e.price ?? null,
    meal: e.meal
      ? {
          slotKey: e.meal.slotKey,
          name: e.meal.name,
          displayName: e.meal.displayName ?? null,
          order: e.meal.order ?? 0,
          menuItems: e.meal.menuItems ?? [],
          imageUrl: e.meal.imageUrl ?? null,
          description: e.meal.description ?? null,
          price: e.meal.price ?? null,
          attendanceWindowOpen: e.meal.attendanceWindowOpen ?? null,
          attendanceWindowClose: e.meal.attendanceWindowClose ?? null,
        }
      : undefined,
  };
}

/**
 * Materialise `publishedSnapshot` for a PUBLISHED row that still has none, so
 * its live entries can safely be replaced. No-op in every other case.
 *
 * MUST be called inside the same transaction as the clearing write.
 */
export async function freezeLegacyPublishedSnapshot(
  tx: any,
  row: SnapshotFreezeRow | null | undefined,
): Promise<void> {
  if (!row?.publishedAt) return;
  const snap = row.publishedSnapshot;
  if (Array.isArray(snap) && snap.length > 0) return;

  const live = await tx.scheduleEntry.findMany({
    where: { scheduleId: row.id },
    include: { meal: { select: SNAPSHOT_MEAL_SELECT } },
    orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
  });
  if (live.length === 0) return;

  await tx.mealSchedule.update({
    where: { id: row.id },
    data: { publishedSnapshot: live.map(toSnapshotEntry) },
  });
}
