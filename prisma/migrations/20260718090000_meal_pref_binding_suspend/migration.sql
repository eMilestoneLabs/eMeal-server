-- Live-Test-8 ISSUE-001/002: preference-mode switching must PRESERVE a meal's
-- preference groups. A suspended binding (isActive=false) keeps the group and
-- its options attached to the meal but drops it from every effective view
-- (rendering, validation, auto-attendance exclusion), so switching a meal to
-- Standalone and back restores the exact prior group configuration.
-- Additive + idempotent: existing rows default to true (no behaviour change).
ALTER TABLE "meal_preference_groups"
  ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
