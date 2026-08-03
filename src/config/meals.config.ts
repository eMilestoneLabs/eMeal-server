import { registerAs } from '@nestjs/config';

/**
 * Meal-system configuration (SRS Module 03) — centralizes the MMT tunables so
 * nothing is hardcoded. All values are environment-overridable.
 *
 * Backed requirements:
 *   MMT-001 / MMT-014 — Master Meal Template holds up to a configurable
 *                       maximum of meals per group (default 10).
 */
export default registerAs('meals', () => ({
  maxMealsPerGroup: parseInt(process.env.MEALS_MAX_PER_GROUP ?? '10', 10),
  // SRS Module 03 MODE-003 (POLICY-5-WINDOWS): max attendance windows per day
  // for Attendance-Only groups — the Master Attendance Template cap.
  attendanceMaxWindows: parseInt(
    process.env.ATTENDANCE_MAX_WINDOWS ?? '5',
    10,
  ),
}));
