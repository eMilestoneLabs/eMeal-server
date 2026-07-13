-- command_6 (survey 2026-07-13) — member-consent debit workflow.
-- Additive: existing ledger rows backfill to 'posted' (they were all live).
ALTER TABLE "billing_ledger_entries" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'posted';
ALTER TABLE "billing_ledger_entries" ADD COLUMN "decidedAt" TIMESTAMP(3);
ALTER TABLE "billing_ledger_entries" ADD COLUMN "decidedBy" TEXT;

-- Student pending-approval lookups (GET /billing/adjustments/my-pending).
CREATE INDEX "billing_ledger_entries_userId_status_idx" ON "billing_ledger_entries"("userId", "status");
