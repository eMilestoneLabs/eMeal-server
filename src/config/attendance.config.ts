import { registerAs } from '@nestjs/config';

/**
 * Attendance timing/concurrency configuration (SRS Pass 6) — centralizes the
 * FR-TIME/FR-CONC tunables so nothing is hardcoded. All values are
 * environment-overridable.
 *
 * Backed requirements:
 *   FR-CONC-003 — double-tap dedup window on POST /attendance (seconds;
 *                 0 disables the Redis dedup guard entirely).
 */
export default registerAs('attendance', () => ({
  markDedupTtlSeconds: parseInt(
    process.env.ATTENDANCE_MARK_DEDUP_TTL_SECONDS ?? '3',
    10,
  ),
}));
