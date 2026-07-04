-- Pass 14 (Events deep + Delete flows + Data lifecycle) — purely additive.

-- FR-DEL-011 / FR-DLC-003 (LOOP-080, SC-082): account-deletion marker.
-- The user ROW is retained (attendance/billing/audit FKs stay intact);
-- PII fields are anonymized in place and this timestamp records when.
ALTER TABLE "users" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- FR-EVTX-002 (LOOP-072): party resume — a stable client-generated device
-- key lets a guest re-open the app and land on their EXISTING party instead
-- of creating a duplicate. Partial unique index = race-proof resume.
ALTER TABLE "event_guest_parties" ADD COLUMN "deviceKey" TEXT;
CREATE UNIQUE INDEX "event_guest_parties_eventId_deviceKey_key"
  ON "event_guest_parties"("eventId", "deviceKey") WHERE "deviceKey" IS NOT NULL;

-- FR-EVTX-031: last-writer-wins by SERVER timestamp needs the timestamp.
ALTER TABLE "event_persons" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- FR-DLC-006 (LOOP-084): tamper-evident audit rows — HMAC-SHA256 over the
-- row's canonical content, keyed by env AUDIT_HMAC_SECRET (absent = unsigned).
ALTER TABLE "audit_logs" ADD COLUMN "integrityHmac" TEXT;
