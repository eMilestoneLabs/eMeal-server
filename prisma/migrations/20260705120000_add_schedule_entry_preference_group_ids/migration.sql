-- #3 (additive, zero data loss): per-day SUBSET of a meal's master preference
-- groups that apply on a given weekly-schedule entry. Empty array = inherit ALL
-- master groups (the existing behaviour), so every existing row is unaffected.
-- Mirrors the proven enabledPreferences / menuItems columns exactly.
ALTER TABLE "schedule_entries" ADD COLUMN "enabledPreferenceGroupIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
