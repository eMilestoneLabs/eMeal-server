import { registerAs } from '@nestjs/config';

/**
 * SRS Module 03 RET-001..015 — rolling data-retention configuration.
 *
 * The SRS fixes the shape of the policy (≈3-month rolling retention, 7 daily
 * reminders, 3-day grace, archive-before-delete); the env knobs exist as
 * operational levers, not product configuration.
 */
export default registerAs('retention', () => ({
  // RET-001/012: rolling live-retention window in months.
  months: parseInt(process.env.RETENTION_MONTHS ?? '3', 10),
  // RET-005: daily reminder days once the oldest period is eligible.
  reminderDays: parseInt(process.env.RETENTION_REMINDER_DAYS ?? '7', 10),
  // RET-006: additional manual-finalization grace days after the reminders.
  graceDays: parseInt(process.env.RETENTION_GRACE_DAYS ?? '3', 10),
  // Sweep cadence in minutes (0 disables the whole subsystem).
  sweepMinutes: parseInt(process.env.RETENTION_SWEEP_MINUTES ?? '360', 10),
}));
