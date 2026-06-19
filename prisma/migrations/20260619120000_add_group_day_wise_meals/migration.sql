-- Additive: Day-Wise Meal Mode group toggle (mutually exclusive with weeklyMenuEnabled).
-- Backfills false for all existing groups; no data loss, no breaking change.
ALTER TABLE "groups" ADD COLUMN "dayWiseMealsEnabled" BOOLEAN NOT NULL DEFAULT false;
