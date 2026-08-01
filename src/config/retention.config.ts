import { registerAs } from '@nestjs/config';

/**
 * SRS Module 03 RET-001..015 — rolling data-retention configuration.
 *
 * The SRS fixes the shape of the policy (≈3-month rolling retention, 7 daily
 * reminders, 3-day grace, archive-before-delete); the env knobs exist as
 * operational levers, not product configuration.
 */
export default registerAs('retention', () => ({
  // Number of COMPLETE billing cycles retained before the frozen purge
  // boundary. THE retention anchor — the boundary is always a real billing
  // cycle end, never "group creation + N months" and never a drifting
  // "now + N months". The ACTIVE cycle is never included.
  cycles: parseInt(process.env.RETENTION_CYCLES ?? '3', 10),
  // RET-001/012: legacy month-based window. Superseded by `cycles`; kept so
  // any operator env override still parses.
  months: parseInt(process.env.RETENTION_MONTHS ?? '3', 10),
  // Daily admin warnings, counted BACKWARDS from the purge boundary so they
  // land inside the final retained cycle — i.e. before the destructive
  // boundary, while the data still exists.
  reminderDays: parseInt(process.env.RETENTION_REMINDER_DAYS ?? '7', 10),
  // RET-006: legacy post-cycle grace. No longer applied — the 7-day ADVANCE
  // warning replaces it. Retained so existing env files keep parsing.
  graceDays: parseInt(process.env.RETENTION_GRACE_DAYS ?? '3', 10),
  // Sweep cadence in minutes (0 disables the whole subsystem).
  sweepMinutes: parseInt(process.env.RETENTION_SWEEP_MINUTES ?? '360', 10),
}));
