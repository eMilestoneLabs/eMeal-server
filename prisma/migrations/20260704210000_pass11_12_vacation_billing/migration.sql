-- Pass 11 (Vacation deep) + Pass 12 (Billing deep) — purely additive.

-- FR-VACX-001: group policy — dated request + approval replaces the instant toggle.
ALTER TABLE "groups" ADD COLUMN "vacationRequiresApproval" BOOLEAN NOT NULL DEFAULT false;

-- FR-BILLX-020: configurable billing cycle start day (1–28); NULL = calendar month.
ALTER TABLE "groups" ADD COLUMN "billingCycleStartDay" INTEGER;

-- FR-VACX-003: optional meal-granular vacation boundaries.
ALTER TABLE "vacation_requests" ADD COLUMN "startSlotKey" TEXT;
ALTER TABLE "vacation_requests" ADD COLUMN "endSlotKey" TEXT;

-- FR-BILLX-030/031/033 (LOOP-010, GAP-103): append-only billing ledger.
CREATE TABLE "billing_ledger_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refRecordId" TEXT,
    "refGuestId" TEXT,
    "refRequestId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_ledger_entries_organizationId_idx" ON "billing_ledger_entries"("organizationId");
CREATE INDEX "billing_ledger_entries_groupId_entryDate_idx" ON "billing_ledger_entries"("groupId", "entryDate");
CREATE INDEX "billing_ledger_entries_groupId_userId_entryDate_idx" ON "billing_ledger_entries"("groupId", "userId", "entryDate");
