-- Additive: per-day meal description override on schedule entries.
-- Nullable (null = inherit the master meal's description). Safe, non-breaking.
ALTER TABLE "schedule_entries" ADD COLUMN "description" TEXT;
