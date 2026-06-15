-- Additive (#8): per-group functional role.
-- Nullable, no default, no backfill -> safe additive change. Existing rows get NULL.
-- Client falls back to the user's global User.role when this is NULL.
ALTER TABLE "group_members" ADD COLUMN "functionalRole" "UserRole";
