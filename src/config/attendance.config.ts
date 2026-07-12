import { registerAs } from '@nestjs/config';

/**
 * Attendance timing/concurrency/governance configuration (SRS Pass 6 + 7) —
 * centralizes the FR-TIME/FR-CONC/FR-TRUST tunables so nothing is hardcoded.
 * All values are environment-overridable.
 *
 * Backed requirements:
 *   FR-CONC-003  — double-tap dedup window on POST /attendance (seconds;
 *                  0 disables the Redis dedup guard entirely).
 *   FR-TRUST-001 — system-default sweep cadence for opt-out groups (minutes;
 *                  0 disables the sweep entirely).
 *   FR-TRUST-003 — fair-opportunity floor: minimum minutes an attendance
 *                  window must have been open for opt-out auto-billing.
 *   LOOP-024     — bounded admin backfill for override/bulk (days).
 *   FR-ATT-033   — governed bulk-override row cap (LOOP-032 partial control).
 */
export default registerAs('attendance', () => ({
  markDedupTtlSeconds: parseInt(
    process.env.ATTENDANCE_MARK_DEDUP_TTL_SECONDS ?? '3',
    10,
  ),
  systemDefaultSweepMinutes: parseInt(
    process.env.ATTENDANCE_SYSTEM_DEFAULT_SWEEP_MINUTES ?? '10',
    10,
  ),
  minOptOutMinutes: parseInt(
    process.env.ATTENDANCE_MIN_OPT_OUT_MINUTES ?? '30',
    10,
  ),
  adminBackfillDays: parseInt(
    process.env.ATTENDANCE_ADMIN_BACKFILL_DAYS ?? '30',
    10,
  ),
  bulkOverrideMaxRows: parseInt(
    process.env.ATTENDANCE_BULK_OVERRIDE_MAX_ROWS ?? '100',
    10,
  ),
  // Pass 11 (FR-VACX-006): vacation lifecycle sweep cadence — activates
  // future-dated approved vacations on their start date and auto-resumes
  // tracking the day after endDate, org-timezone-correct, even for users who
  // never open the app. 0 disables (read-time sync still applies).
  vacationSweepMinutes: parseInt(
    process.env.VACATION_SWEEP_MINUTES ?? '30',
    10,
  ),
  // Pass 14 (FR-EVT-054): expired-event cleanup fan-out cadence. Per-org jobs
  // are day-deduped (jobId embeds the UTC date), so a smaller interval only
  // affects how soon after midnight the deactivate+purge fires. 0 disables.
  eventCleanupSweepMinutes: parseInt(
    process.env.EVENT_CLEANUP_SWEEP_MINUTES ?? '360',
    10,
  ),
  // Pass 12 (FR-BILLX-050): billing-summary read-cache TTL. Correctness is
  // version-guarded (any billing write orphans the cache instantly); the TTL
  // only bounds Redis memory for orphaned keys. 0 disables the read cache.
  billingSummaryCacheTtlSeconds: parseInt(
    process.env.BILLING_SUMMARY_CACHE_TTL_SECONDS ?? '60',
    10,
  ),
  // Pass 15 (FR-NOTX-010): weekly attendance summary digest. The sweep runs
  // every N minutes but each group fires at most once per digest day (Redis
  // once-flag), when org-local time reaches digestHour on digestDay
  // (0=Sunday … 6=Saturday). 0 sweep minutes disables the digest entirely.
  weeklyDigestSweepMinutes: parseInt(
    process.env.WEEKLY_DIGEST_SWEEP_MINUTES ?? '60',
    10,
  ),
  weeklyDigestDay: parseInt(process.env.WEEKLY_DIGEST_DAY ?? '1', 10),
  weeklyDigestHour: parseInt(process.env.WEEKLY_DIGEST_HOUR ?? '8', 10),
  // Pass 15 (FR-NOTX-010): attendance-reminder scheduling sweep cadence.
  // Enqueues today's 30/10-min pre-close reminder jobs; repeats are no-ops
  // (BullMQ jobId dedup + the dispatch worker's Redis flag). 0 disables.
  reminderScheduleSweepMinutes: parseInt(
    process.env.REMINDER_SCHEDULE_SWEEP_MINUTES ?? '15',
    10,
  ),
  // SRS Module 03 ATT-010: Personal Auto-Attendance materialization sweep —
  // marks opted-in members Present as soon as a window OPENS (cadence bounds
  // "immediately"; each meal/date materializes exactly once). 0 disables.
  autoAttendanceSweepMinutes: parseInt(
    process.env.ATTENDANCE_AUTO_SWEEP_MINUTES ?? '2',
    10,
  ),
}));
