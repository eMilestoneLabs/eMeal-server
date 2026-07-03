import { registerAs } from '@nestjs/config';

/**
 * Attendance Correction Request (Module 33) configuration — centralizes every
 * ACR tunable so nothing is hardcoded (MIG-011 §5). All values are
 * environment-overridable.
 *
 * Backed requirements:
 *   FR-ACR-001  — bounded backfill (maxAgeDays) + per-member rate limits.
 *   FR-ACR-011  — pending requests auto-expire after expiryHours.
 *   FR-ACR-001  — liability-DECREASING corrections may auto-approve
 *                 (absentAutoApprove, default true — favors the member).
 */
export default registerAs('corrections', () => ({
  // Hours a pending request stays actionable before it auto-expires.
  expiryHours: parseInt(process.env.ACR_EXPIRY_HOURS ?? '48', 10),
  // How many days back a member may request a correction (bounded backfill).
  maxAgeDays: parseInt(process.env.ACR_MAX_AGE_DAYS ?? '7', 10),
  // Max simultaneously-open (pending) requests per member.
  maxOpenPerMember: parseInt(process.env.ACR_MAX_OPEN_PER_MEMBER ?? '3', 10),
  // Max requests a member may create per calendar day (org timezone).
  maxPerDay: parseInt(process.env.ACR_MAX_PER_DAY ?? '5', 10),
  // Auto-approve liability-decreasing corrections (correct_to_absent/skip).
  absentAutoApprove:
    (process.env.ACR_ABSENT_AUTO_APPROVE ?? 'true') !== 'false',
}));
