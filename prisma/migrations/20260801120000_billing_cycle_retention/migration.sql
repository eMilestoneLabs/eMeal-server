-- Billing-cycle-aligned 3-cycle retention (additive, nullable, zero backfill).
--
-- "retentionPurgeThrough" : FROZEN purge boundary = the last day of the 3rd
--   complete billing cycle of the current retention window. Stored rather than
--   derived from now() so a late or retried sweep can NEVER let the cutoff
--   drift forward into the ACTIVE cycle. Advances by exactly 3 cycles after a
--   successful purge. NULL = not yet initialized (the first sweep computes it
--   from the group's billing cycle).
--
-- "billingCycleChangedAt" : consumes the one-time billing-cycle-start-day
--   change per group. NULL = the change is still available. This is the
--   server-side source of truth, so reinstalling the app, clearing local
--   cache or logging out can never restore the privilege.
--
-- Both columns are NULLABLE with no default, so existing rows are untouched
-- and NO backfill is required (mobile-test groups are recreated manually).
-- Idempotent so a re-run during live testing is safe.
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "retentionPurgeThrough" TIMESTAMP(3);
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS "billingCycleChangedAt" TIMESTAMP(3);

-- The retention sweep selects active groups whose frozen boundary is due, or
-- which are still uninitialized. Partial index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS "groups_retentionPurgeThrough_idx"
  ON "groups" ("retentionPurgeThrough")
  WHERE "isActive" = true;
