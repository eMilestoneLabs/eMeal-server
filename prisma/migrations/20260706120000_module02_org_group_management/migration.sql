-- MODULE_02 (Organization & Group Management) — purely additive.
-- All new columns are nullable or defaulted so existing rows/behaviour are
-- untouched (backward compatible; freeze-safe).

-- GRP-003 / ORG-008: extended Group metadata captured at creation, immutable in
-- the current release (kept configurable-ready for a future release).
ALTER TABLE "groups" ADD COLUMN "country" TEXT;
ALTER TABLE "groups" ADD COLUMN "state" TEXT;
ALTER TABLE "groups" ADD COLUMN "city" TEXT;
ALTER TABLE "groups" ADD COLUMN "address" TEXT;
ALTER TABLE "groups" ADD COLUMN "timezone" TEXT;
ALTER TABLE "groups" ADD COLUMN "currency" TEXT;

-- GRP-003 / MEM-004: Join Approval Mode. true = a join creates a PENDING member
-- an admin must approve before it becomes active.
ALTER TABLE "groups" ADD COLUMN "joinApprovalRequired" BOOLEAN NOT NULL DEFAULT false;

-- GRP-013 / CFG-014: QR/Join-Code expiry policy (days). NULL = Never expires.
ALTER TABLE "groups" ADD COLUMN "qrExpiryDays" INTEGER;

-- GRP-016/019: soft-archive timestamp for the restore / permanent-delete
-- lifecycle. NULL while active.
ALTER TABLE "groups" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- MEM-004/006/007: Join Approval decision trail on the membership row.
ALTER TABLE "group_members" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "group_members" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "group_members" ADD COLUMN "reviewNote" TEXT;
