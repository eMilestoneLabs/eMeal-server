-- Live-Test-11 ISSUE-017 (survey-locked): independent "Bill Absent Meals"
-- toggle, date-forward. The policy is SNAPSHOTTED onto each absent record at
-- write time — NULL (every existing record) = free, so no past bill changes.
-- Additive + idempotent.
ALTER TABLE "attendance_records" ADD COLUMN IF NOT EXISTS "billAbsent" BOOLEAN;
