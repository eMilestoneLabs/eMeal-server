import { UnprocessableEntityException } from '@nestjs/common';
import { GENERAL_ATTENDANCE_SLOT_KEY } from '../serializers/meal.serializer';
import { hhmmToMinutes } from './entry-chrono.util';

/**
 * Live-Test-16 ISSUE-2 — the ONE attendance-window scheduling invariant.
 *
 * ## The rule (user-locked 2026-08-02)
 * 1. EVERY admin-configured meal / attendance window must carry BOTH an
 *    opening and a closing time. A missing window is no longer interpreted as
 *    "open all day" for configuration purposes.
 * 2. A window must open and close inside the SAME org-local calendar date —
 *    `close > open`. Overnight windows (23:00 → 01:00) are rejected: the
 *    runtime `getWindowState` cannot represent them either (`t < open` pins
 *    them to `upcoming` forever), so they never worked.
 * 3. Two windows applying to the same date must never overlap, and consecutive
 *    windows must be separated by at least `gapMinutes` (default 60):
 *        next.open >= previous.close + gapMinutes
 *    Exactly one hour is valid; 59 minutes is not.
 * 4. Validation is LINEAR WITHIN A DATE. The next calendar date starts a new
 *    attendance lifecycle, so today's last window is never compared against
 *    tomorrow's first one.
 *
 * ## The one exemption
 * The implicit `__general__` attendance slot (`MealsService.ensureGeneralSlot`)
 * is a SYSTEM row, not an admin-created window: it is deliberately created with
 * a null window, is hidden from every meal list, and is excluded from the meal
 * cap. It is filtered out here so Attendance-Only internals keep working.
 *
 * ## Why a pure module
 * The invariant has to hold on six different write paths (master meal create /
 * update, schedule create / update, replace-and-publish, flag-flip publish).
 * Keeping it as a dependency-free pure function means every path shares ONE
 * implementation (DRY) and none of them pays an extra query — each caller
 * already holds the rows it passes in.
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

interface ParsedWindow extends MealWindowRef {
  open: number;
  close: number;
}

/** 545 → "9:05 AM" (admin-facing; the app renders 12-hour times everywhere). */
function to12h(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** 600 → "10:00". Null when the value falls outside the calendar day. */
function toHHmm(minutes: number): string | null {
  if (minutes < 0 || minutes >= INVALID_MINUTES) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
    minutes % 60,
  ).padStart(2, '0')}`;
}

/** 60 → "1-hour", 120 → "2-hour", 90 → "90-minute". */
function gapLabel(gapMinutes: number): string {
  return gapMinutes % 60 === 0
    ? `${gapMinutes / 60}-hour`
    : `${gapMinutes}-minute`;
}

/** "07:00 – 09:00" rendered for the error payload. */
function windowLabel(open: number, close: number): string {
  return `${to12h(open)} – ${to12h(close)}`;
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

function windowOverlap(
  earlier: ParsedWindow,
  later: ParsedWindow,
  gapMinutes: number,
): UnprocessableEntityException {
  const earliest = earlier.close + gapMinutes;
  return new UnprocessableEntityException({
    message:
      `Attendance Window Conflict — "${later.label}" (${windowLabel(later.open, later.close)}) ` +
      `overlaps "${earlier.label}" (${windowLabel(earlier.open, earlier.close)}). ` +
      `Two meals can never accept attendance at the same time.`,
    code: 'MEAL_WINDOW_CONFLICT',
    errors: {
      reason: 'overlap',
      meal: later.label,
      conflictingMeal: earlier.label,
      existingWindow: windowLabel(earlier.open, earlier.close),
      requestedWindow: windowLabel(later.open, later.close),
      earliestAllowedStart: toHHmm(earliest),
    },
  });
}

function windowGapTooSmall(
  earlier: ParsedWindow,
  later: ParsedWindow,
  gapMinutes: number,
): UnprocessableEntityException {
  const earliest = earlier.close + gapMinutes;
  const earliestHHmm = toHHmm(earliest);
  return new UnprocessableEntityException({
    message:
      `Attendance Window Conflict — "${earlier.label}" attendance ends at ${to12h(earlier.close)}. ` +
      (earliestHHmm
        ? `"${later.label}" attendance cannot begin before ${to12h(earliest)} because a minimum ` +
          `${gapLabel(gapMinutes)} gap is required between different meal attendance windows.`
        : `"${later.label}" cannot be scheduled on the same day — a minimum ${gapLabel(gapMinutes)} ` +
          `gap is required and the day ends first.`),
    code: 'MEAL_WINDOW_CONFLICT',
    errors: {
      reason: 'gap',
      meal: later.label,
      conflictingMeal: earlier.label,
      existingWindow: windowLabel(earlier.open, earlier.close),
      requestedWindow: windowLabel(later.open, later.close),
      earliestAllowedStart: earliestHHmm,
    },
  });
}

/**
 * Assert that every window is present + same-day, and that the SET has no
 * overlap and keeps at least `gapMinutes` between consecutive windows.
 *
 * Pure and total: throws a 422 with a stable `code` on the first violation,
 * returns void otherwise. Callers pass the windows that apply to ONE date (or
 * the whole master template, which is itself a single per-day set).
 */
export function assertMealWindowsValid(
  windows: readonly MealWindowRef[],
  gapMinutes: number,
): void {
  const gap = Math.max(0, Math.trunc(gapMinutes));

  const parsed: ParsedWindow[] = [];
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
    parsed.push({ ...w, open, close });
  }

  if (parsed.length < 2) return;

  parsed.sort(
    (a, b) =>
      a.open - b.open || a.close - b.close || a.mealId.localeCompare(b.mealId),
  );

  // Compare against the LATEST close seen so far, not just the previous row:
  // a fully-contained window (07:00–12:00 vs 08:00–09:00) must still be caught.
  let boundary = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    const current = parsed[i];
    if (current.open < boundary.close) throw windowOverlap(boundary, current, gap);
    if (current.open - boundary.close < gap) {
      throw windowGapTooSmall(boundary, current, gap);
    }
    if (current.close > boundary.close) boundary = current;
  }
}
