-- Additive (#6): per-day meal preference on schedule entries.
-- Nullable / defaulted -> safe additive change; existing rows unaffected, no backfill.
ALTER TABLE "schedule_entries" ADD COLUMN "preferencesEnabled" BOOLEAN;
ALTER TABLE "schedule_entries" ADD COLUMN "enabledPreferences" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
