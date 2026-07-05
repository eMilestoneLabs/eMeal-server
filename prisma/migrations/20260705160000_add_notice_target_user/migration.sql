-- Notification Center (command_3): per-member targeted notices. When set, only
-- that user sees the notice (approval/rejection decisions). Additive + nullable;
-- null = audience-scoped notice for everyone in scope (legacy behaviour).
ALTER TABLE "notices" ADD COLUMN "targetUserId" TEXT;
CREATE INDEX "notices_targetUserId_idx" ON "notices" ("targetUserId");
