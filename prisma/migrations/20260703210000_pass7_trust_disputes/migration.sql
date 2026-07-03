-- Pass 7 (Block C — Trust, Disputes & Governance). Additive only.
-- FR-TRUST-001/003: group trust model + fair-opportunity floor.
ALTER TABLE "groups" ADD COLUMN "attendanceDefault" TEXT;
ALTER TABLE "groups" ADD COLUMN "minOptOutMinutes" INTEGER;

-- FR-DISP-010: billing period finalization & controlled reopen.
CREATE TABLE "billing_periods" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'finalized',
    "finalizedBy" TEXT NOT NULL,
    "finalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedBy" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,
    "totalsSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_periods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_periods_organizationId_idx" ON "billing_periods"("organizationId");
CREATE INDEX "billing_periods_groupId_status_idx" ON "billing_periods"("groupId", "status");
CREATE INDEX "billing_periods_groupId_periodStart_periodEnd_idx" ON "billing_periods"("groupId", "periodStart", "periodEnd");
