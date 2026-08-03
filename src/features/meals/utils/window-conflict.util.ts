import { UnprocessableEntityException } from '@nestjs/common';
import { GENERAL_ATTENDANCE_SLOT_KEY } from '../serializers/meal.serializer';
import { hhmmToMinutes } from './entry-chrono.util';

/**
 * Live-Test-16 ISSUE-2 — the attendance-window validity rules.
 *
 * ## The rules (user-locked 2026-08-03)
 * 1. EVERY admin-configured meal / attendance window must carry BOTH an
 *    opening and a closing time. A missing window is no longer interpreted as
 *    "open all day" for configuration purposes.
 * 2. A window must open and close inside the SAME org-local calendar date —
 *    `close > open`. Overnight windows (23:00 → 01:00) are rejected: the
 *    runtime `getWindowState` cannot represent them either (`t < open` pins
 *    them to `upcoming` forever), so they never worked.
 *
 * ## What was deliberately WITHDRAWN (user decision 2026-08-03)
 * The original spec also forbade overlapping windows and required a minimum
 * 1-hour gap between them. Both were removed on request: an admin may schedule
 * ANY NUMBER of CONCURRENT windows — e.g. Breakfast, Lunch and Dinner all
 * open 07:00–09:00 so members declare the whole day in one morning session.
 *
 * Consequences accepted with that decision: when several windows are open at
 * once the attendance reminder fires once per meal, and the dashboard's
 * "current meal" picks one of them. Attendance data itself is unaffected —
 * records are keyed (userId, mealId, attendanceDate), so every meal is still
 * tracked and reported independently.
 *
 * ## The one exemption
 * The implicit `__general__` attendance slot (`MealsService.ensureGeneralSlot`)
 * is a SYSTEM row, not an admin-created window: it is deliberately created with
 * a null window, is hidden from every meal list, and is excluded from the meal
 * cap. It is filtered out here so Attendance-Only internals keep working.
 *
 * ## Why a pure module
 * The rules have to hold on six different write paths (master meal create /
 * update, schedule create / update, replace-and-publish, flag-flip publish).
 * Keeping this a dependency-free pure function means every path shares ONE
 * implementation (DRY) and none of them pays an extra query.
 */

/** `hhmmToMinutes` sentinel for a missing/unparseable "HH:mm". */
const INVALID_MINUTES = 24 * 60;

/** One meal's effective attendance window, as seen by the validator. */
export interface MealWindowRef {
  /** Stable id (meal id, or a synthetic id for a not-yet-persisted meal). */
  mealId: string;
  /** Admin-facing label used verbatim in the error message. */
  label: string;
  /** Used ONLY to exempt the implicit general-attendance slot. */
  slotKey?: string | null;
  openTime?: string | null;
  closeTime?: string | null;
}

function windowRequired(w: MealWindowRef): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `"${w.label}" needs an attendance window — set both an opening and a closing time before saving.`,
    code: 'MEAL_WINDOW_REQUIRED',
    errors: {
      meal: w.label,
      attendanceWindow: 'Opening and closing time are both required',
    },
  });
}

function windowNotSameDay(w: MealWindowRef): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: `"${w.label}" must open and close on the same day — the closing time has to be later than the opening time.`,
    code: 'MEAL_WINDOW_INVALID',
    errors: {
      meal: w.label,
      attendanceWindow:
        'Closing time must be after opening time — overnight windows are not supported',
    },
  });
}

/**
 * Assert that every supplied window is present and same-day.
 *
 * Validation is PER WINDOW — windows are never compared with one another, so
 * any number of them may run concurrently.
 *
 * Pure and total: throws a 422 with a stable `code` on the first violation,
 * returns void otherwise.
 */
export function assertMealWindowsValid(
  windows: readonly MealWindowRef[],
): void {
  for (const w of windows) {
    // The implicit general-attendance slot is a system row — never validated.
    if ((w.slotKey ?? null) === GENERAL_ATTENDANCE_SLOT_KEY) continue;

    const open = hhmmToMinutes(w.openTime ?? null);
    const close = hhmmToMinutes(w.closeTime ?? null);
    if (
      !w.openTime ||
      !w.closeTime ||
      open === INVALID_MINUTES ||
      close === INVALID_MINUTES
    ) {
      throw windowRequired(w);
    }
    if (close <= open) throw windowNotSameDay(w);
  }
}
