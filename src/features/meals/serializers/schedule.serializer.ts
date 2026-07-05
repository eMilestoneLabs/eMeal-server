import { MealScheduleEntity, ScheduleEntryEntity } from '../entities/meal-schedule.entity';
import { compareEntriesChronologically } from '../utils/entry-chrono.util';

/**
 * ScheduleSerializer — converts MealScheduleEntity to exact Flutter JSON contract.
 *
 * CONTRACT (M-12 — LOCKED, from lib/shared/models/meal_schedule_model.dart):
 * {
 *   "id": "uuid",
 *   "groupId": "uuid",
 *   "organizationId": "uuid",
 *   "isPublished": true,
 *   "publishedAt": "2026-01-01T00:00:00.000Z",
 *   "createdAt": "2026-01-01T00:00:00.000Z",
 *   "days": [
 *     { "day": "monday",    "meals": [{ "mealId": "uuid", "name": "Breakfast", "slotKey": "breakfast", "order": 1, "menuItems": [], "imageUrl": null, "openTime": "07:00", "closeTime": "09:00" }] },
 *     { "day": "tuesday",   "meals": [] },
 *     { "day": "wednesday", "meals": [] },
 *     { "day": "thursday",  "meals": [] },
 *     { "day": "friday",    "meals": [] },
 *     { "day": "saturday",  "meals": [] },
 *     { "day": "sunday",    "meals": [] }
 *   ]
 * }
 *
 * CRITICAL:
 *   - Flutter reads json['days'] NOT json['entries']
 *   - ALL 7 days ALWAYS present — empty meals[] if no entries
 *   - openTime/closeTime are FLAT fields on meal item (not nested attendanceWindow)
 *   - Flutter reads meal json['name'] NOT json['mealName']
 */

const DAY_NAMES = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;

export class ScheduleSerializer {
  static toResponse(schedule: MealScheduleEntity): Record<string, unknown> {
    // Group entries by dayOfWeek index (0=monday ... 6=sunday)
    const entryByDay = new Map<number, ScheduleEntryEntity[]>();
    for (const entry of schedule.entries) {
      if (!entryByDay.has(entry.dayOfWeek)) {
        entryByDay.set(entry.dayOfWeek, []);
      }
      entryByDay.get(entry.dayOfWeek)!.push(entry);
    }

    // Build days[] — ALL 7 days always present (M-12 requirement)
    const days = DAY_NAMES.map((dayName, index) => {
      const dayEntries = entryByDay.get(index) ?? [];
      // FR-MEAL-007 (ISSUE-18): chronological within the day — effective open
      // time (per-day override ?? meal template window), meal.order tie-break.
      const sorted = [...dayEntries].sort(compareEntriesChronologically);
      return {
        day: dayName,
        meals: sorted.map((e) => ScheduleSerializer.entryToMealItem(e)),
      };
    });

    return {
      id: schedule.id,
      groupId: schedule.groupId,
      organizationId: schedule.organizationId ?? null,
      isPublished: schedule.isPublished,
      publishedAt: schedule.publishedAt?.toISOString() ?? null,
      createdAt: schedule.createdAt.toISOString(),
      days,
    };
  }

  /**
   * Meal item within a day.
   * Flutter reads: mealId, name, slotKey, order, menuItems, imageUrl, openTime, closeTime
   */
  static entryToMealItem(entry: ScheduleEntryEntity): Record<string, unknown> {
    const name =
      entry.mealName ?? entry.meal?.displayName ?? entry.meal?.name ?? '';

    return {
      mealId: entry.mealId,
      name,
      slotKey: entry.meal?.slotKey ?? '',
      order: entry.meal?.order ?? 0,
      menuItems:
        entry.menuItems && entry.menuItems.length > 0
          ? entry.menuItems
          : entry.meal?.menuItems ?? [],
      // Additive: per-day meal image override (fallback to master meal image).
      imageUrl: entry.imageUrl ?? entry.meal?.imageUrl ?? null,
      // Additive: per-day meal description (fallback to master meal description).
      description: entry.description ?? entry.meal?.description ?? null,
      // Flat fields — per-day override (null = Flutter uses meal template timing)
      openTime: entry.openTime ?? null,
      closeTime: entry.closeTime ?? null,
      // Additive (#6): per-day meal preference.
      preferencesEnabled: entry.preferencesEnabled ?? false,
      enabledPreferences: entry.enabledPreferences ?? [],
      // #3: per-day subset of master preference group ids (empty = inherit all).
      enabledPreferenceGroupIds: entry.enabledPreferenceGroupIds ?? [],
      // Additive: per-day ₹ price (fallback to master meal price).
      price: entry.price ?? entry.meal?.price ?? null,
    };
  }

  static toList(schedules: MealScheduleEntity[]): Record<string, unknown>[] {
    return schedules.map((s) => ScheduleSerializer.toResponse(s));
  }
}
