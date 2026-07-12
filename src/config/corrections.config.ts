import { registerAs } from '@nestjs/config';

/**
 * Attendance Correction Request (Module 33) configuration — centralizes every
 * ACR tunable so nothing is hardcoded (MIG-011 §5). All values are
 * environment-overridable.
 *
 * Backed requirements:
 *   FR-ACR-011  — pending requests auto-expire after expiryHours.
 *   SRS Module 03 COR-005 — the member submission window is SAME CALENDAR DAY
 *                 ONLY (until 11:59:59 PM IST) and deliberately NOT
 *                 configurable; the former ACR_MAX_AGE_DAYS backfill knob no
 *                 longer applies to creation.
 *   SRS Module 03 ATT-004 — every correction awaits an explicit admin
 *                 approve/reject decision; auto-approval is OFF by default.
 */
export default registerAs('corrections', () => ({
  // Hours a pending request stays actionable before it auto-expires. COR-005
  // keeps pending requests reviewable after the member's same-day submission
  // deadline — this bounds how long they stay actionable.
  expiryHours: parseInt(process.env.ACR_EXPIRY_HOURS ?? '48', 10),
  // Max simultaneously-open (pending) requests per member.
  maxOpenPerMember: parseInt(process.env.ACR_MAX_OPEN_PER_MEMBER ?? '3', 10),
  // Max requests a member may create per calendar day (org timezone).
  maxPerDay: parseInt(process.env.ACR_MAX_PER_DAY ?? '5', 10),
  // SRS Module 03 ATT-004: admin reviews everything — OFF unless deliberately
  // re-enabled via env.
  absentAutoApprove:
    (process.env.ACR_ABSENT_AUTO_APPROVE ?? 'false') === 'true',
}));
