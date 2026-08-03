import { registerAs } from '@nestjs/config';

/**
 * Meal-system configuration (SRS Module 03) — centralizes the MMT tunables so
 * nothing is hardcoded. All values are environment-overridable.
 *
 * Backed requirements:
 *   MMT-001 / MMT-014 — Master Meal Template holds up to a configurable
 *                       maximum of meals per group (default 10).
 */
/**
 * Live-Test-16 F2 — single resolver for the attendance-window gap.
 *
 * The value is env-configurable, but `GroupSerializer` is a static class with
 * no ConfigService, and the Flutter client needs the EFFECTIVE value to run its
 * fast-feedback validation. Without it the app hardcodes 60: raising the gap
 * server-side would surface late errors, and LOWERING it would make the client
 * STRICTER than the server, blocking a configuration the backend accepts.
 *
 * Exported so the config factory and the serializer parse it in exactly ONE
 * place (DRY) — no second literal, no drift.
 */
export const WINDOW_MIN_GAP_MINUTES_DEFAULT = 60;

export const resolveWindowMinGapMinutes = (): number => {
  // FAIL-CLOSED on a malformed value. `parseInt('60min'|'abc'|'')` is NaN, and
  // EVERY comparison against NaN is false — so a typo in the env var would
  // silently switch the minimum-gap rule OFF while the overlap check kept
  // working, making the invariant look healthy when it was gone. A safety rule
  // must never disappear because of an ops typo, so anything not a finite
  // non-negative number falls back to the documented default.
  const parsed = parseInt(process.env.MEALS_WINDOW_MIN_GAP_MINUTES ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : WINDOW_MIN_GAP_MINUTES_DEFAULT;
};

export default registerAs('meals', () => ({
  maxMealsPerGroup: parseInt(process.env.MEALS_MAX_PER_GROUP ?? '10', 10),
  // SRS Module 03 MODE-003 (POLICY-5-WINDOWS): max attendance windows per day
  // for Attendance-Only groups — the Master Attendance Template cap.
  attendanceMaxWindows: parseInt(
    process.env.ATTENDANCE_MAX_WINDOWS ?? '5',
    10,
  ),
  // Live-Test-16 ISSUE-2: minimum gap (minutes) between the CLOSE of one
  // attendance window and the OPEN of the next one on the same date. The
  // configured close time is the reference — a group's attendance grace
  // period deliberately does NOT shift this scheduling boundary.
  windowMinGapMinutes: resolveWindowMinGapMinutes(),
}));
