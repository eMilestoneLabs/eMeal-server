-- Additive: per-day meal image override on schedule entries.
-- One image per entry (base64 data URI or URL). Nullable = inherit the master
-- meal image. Re-upload overwrites this column (no historical copies); delete
-- sets it back to NULL. Safe, non-breaking.
ALTER TABLE "schedule_entries" ADD COLUMN "imageUrl" TEXT;
