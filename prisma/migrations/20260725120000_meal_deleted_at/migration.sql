-- ISSUE-001 (Live-Test-13): separate DELETE from DISABLE on Master Meals.
--
-- Until now both operations only set "isActive" = false, so the two were
-- indistinguishable. That made it impossible to list DISABLED meals for
-- re-enabling without also resurrecting DELETED ones (which came back showing
-- an "Enable" button).
--
--   deletedAt IS NULL      -> DISABLED (temporary; stays in the Master Meal
--                             Template and can be re-enabled)
--   deletedAt IS NOT NULL  -> DELETED  (permanent; never listed in the
--                             template, can never be re-enabled)
--
-- The meal ROW is never physically removed: attendance records, billing rows,
-- reports and previously published schedule snapshots all reference it, and
-- that history must stay intact. Only the Master Meal Template loses it.

ALTER TABLE "meals" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Backfill (user-directed): legacy archived meals cannot be classified —
-- the old schema never recorded WHICH operation archived them. Treating them
-- all as DELETED preserves the behaviour every previous release had (deleted
-- meals stayed gone and never offered an Enable button), so no meal that was
-- intentionally deleted months ago suddenly reappears. From this migration
-- onward the two operations are recorded distinctly.
-- "updatedAt" is used as the deletion timestamp: it is the closest available
-- record of when the row was archived. Historical data is NOT touched.
UPDATE "meals" SET "deletedAt" = "updatedAt" WHERE "isActive" = false;

CREATE INDEX "meals_deletedAt_idx" ON "meals"("deletedAt");
