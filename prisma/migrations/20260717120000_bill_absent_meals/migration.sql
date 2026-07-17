-- Live-Test-7 ISSUE-4: independent "Bill Absent Meals" toggle.
-- NULL = legacy coupling: Absent billing follows billSkippedMeals (the exact
-- pre-split behaviour), so no existing group's bill changes on deploy.
-- Additive + idempotent.
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "billAbsentMeals" BOOLEAN;
