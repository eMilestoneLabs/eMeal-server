import { registerAs } from '@nestjs/config';

/**
 * Organization & Group management configuration (SRS MODULE_02) — centralizes
 * every configurable limit so nothing is hardcoded (CFG-001 mandate). All
 * values are environment-overridable and read through @nestjs/config.
 *
 * Backed requirements:
 *   ORG-012 / GRP-005 / CFG-012 — max Groups per Organization (default 5).
 *   GRP-004 / CFG-002/003/004   — per-Organization-Role maximum member limit.
 *   GRP-011 / CFG-015           — fixed-length system-generated Join Code.
 *   GRP-013 / CFG-014           — configurable QR expiry (Never or N days).
 *   NTF-005 / CFG-016           — notification retention window (default 30d).
 *
 * CFG-003 default role member limits (exact SRS values):
 *   Hostel Admin=50, Hostel Manager=50, Mess Manager=30,
 *   Organization Manager=100, Event Admin=100.
 * Roles not listed fall back to `defaultRoleMemberLimit`.
 */
export default registerAs('groups', () => {
  const intOr = (v: string | undefined, d: number): number => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };

  return {
    // ORG-012 / GRP-005 / CFG-012: max Groups an Organization may own.
    maxGroupsPerOrg: intOr(process.env.GROUPS_MAX_PER_ORG, 5),

    // GRP-011 / CFG-015: fixed Join Code length (system-generated, unique).
    joinCodeLength: intOr(process.env.GROUPS_JOIN_CODE_LENGTH, 8),

    // GRP-013 / CFG-014: default QR expiry in days when the admin does not
    // specify one at creation. 0 / unset = Never expires (null policy).
    defaultQrExpiryDays: intOr(process.env.GROUPS_QR_EXPIRY_DAYS_DEFAULT, 0),

    // NTF-005 / CFG-016: notification (bell notice) retention window in days.
    notificationRetentionDays: intOr(
      process.env.NOTIFICATION_RETENTION_DAYS,
      30,
    ),

    // GRP-004 / CFG-002/003/004: per-Organization-Role maximum member limit.
    // The value entered by the admin at Group creation must be ≤ this limit for
    // the creating admin's Organization Role. Existing Groups keep their own
    // capacity even if these limits later change (CFG-018).
    roleMemberLimits: {
      hostelAdmin: intOr(process.env.GROUPS_ROLE_LIMIT_HOSTEL_ADMIN, 50),
      hostelManager: intOr(process.env.GROUPS_ROLE_LIMIT_HOSTEL_MANAGER, 50),
      messManager: intOr(process.env.GROUPS_ROLE_LIMIT_MESS_MANAGER, 30),
      organizationManager: intOr(
        process.env.GROUPS_ROLE_LIMIT_ORG_MANAGER,
        100,
      ),
      eventAdmin: intOr(process.env.GROUPS_ROLE_LIMIT_EVENT_ADMIN, 100),
    } as Record<string, number>,

    // Fallback role member limit for any role not explicitly configured above.
    defaultRoleMemberLimit: intOr(process.env.GROUPS_ROLE_LIMIT_DEFAULT, 50),

    // SRS Module 03 GLC-003 (survey Q7): archived groups are restorable for
    // this many days, then automatically PERMANENTLY deleted with NO
    // operational validation (the group has already been inactive that long).
    archiveRetentionDays: intOr(process.env.GROUP_ARCHIVE_RETENTION_DAYS, 30),

    // Sweep cadence for the archived-group purge (minutes; 0 disables).
    archivePurgeSweepMinutes: intOr(
      process.env.GROUP_ARCHIVE_PURGE_SWEEP_MINUTES,
      720,
    ),

    // GRP-004: minimum Maximum-Members an admin must set when capping a group.
    // Used as the floor of the create-time range check (default 2 → "2 to N").
    minMembers: intOr(process.env.GROUPS_MIN_MEMBERS, 2),

    // GRP-012: HMAC secret for the signed QR payload (org+group+expiry+sig).
    // Dedicated secret preferred; falls back to an existing app secret so
    // signing always works. Never logged, never returned in responses.
    qrSigningSecret:
      process.env.QR_SIGNING_SECRET ??
      process.env.JWT_ACCESS_SECRET ??
      process.env.JWT_REFRESH_SECRET ??
      'emeal-qr-dev-secret',
  };
});
