import { ScheduleEntryEntity } from '../entities/meal-schedule.entity';

/**
 * FR-MEAL-007 (ISSUE-18) — chronological meal-ordering helpers, shared by the
 * schedules repository, the schedule serializer and the meals service so the
 * ordering rule lives in exactly one place.
 *
 * Effective open time of a schedule entry = per-day override (`openTime`) ??
 * the meal template window (`meal.attendanceWindowOpen`). "HH:mm" parses to
 * minutes-since-midnight; anything unresolvable sorts LAST, mirroring the
 * meals-list `nulls: 'last'` SQL ordering.
 */

/** "HH:mm" → minutes since midnight; null/invalid → 1440 (sorts last). */
export function hhmmToMinutes(t: string | null | undefined): number {
  if (typeof t !== 'string') return 24 * 60;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return 24 * 60;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? 24 * 60 : h * 60 + min;
}

/** Effective open minutes of a schedule entry (override ?? meal template). */
export function entryOpenMinutes(e: ScheduleEntryEntity): number {
  return hhmmToMinutes(e.openTime ?? e.meal?.attendanceWindowOpen ?? null);
}

/** Effective-open-time ASC, meal.order ASC, mealId ASC (stable final key). */
export function compareEntriesChronologically(
  a: ScheduleEntryEntity,
  b: ScheduleEntryEntity,
): number {
  const ak = entryOpenMinutes(a);
  const bk = entryOpenMinutes(b);
  if (ak !== bk) return ak - bk;
  const ao = a.meal?.order ?? 0;
  const bo = b.meal?.order ?? 0;
  if (ao !== bo) return ao - bo;
  return a.mealId.localeCompare(b.mealId);
}
