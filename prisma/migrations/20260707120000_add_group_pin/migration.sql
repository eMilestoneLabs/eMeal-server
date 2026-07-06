-- command_3 Issue 8: capture the group's postal/PIN code at creation.
-- Additive + nullable so existing rows are untouched (GRP-003 metadata family).
ALTER TABLE "groups" ADD COLUMN "pin" TEXT;
