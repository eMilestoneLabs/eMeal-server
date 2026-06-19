-- Additive: per-day menu items on schedule entries (independent of master meal).
ALTER TABLE "schedule_entries" ADD COLUMN "menuItems" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
