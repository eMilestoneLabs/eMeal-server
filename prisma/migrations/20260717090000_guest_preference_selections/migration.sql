-- Live-Test-6 ISSUE-2: per-guest multi-preference-group selections.
-- Additive nullable JSON column — immutable snapshot of the guest's chosen
-- preference-group options at booking (same shape as attendance_records
-- .preferences). Price deltas are folded into price_snapshot at write time,
-- so billing reads stay single-column and unchanged.
ALTER TABLE "meal_guests" ADD COLUMN IF NOT EXISTS "preferences" JSONB;
