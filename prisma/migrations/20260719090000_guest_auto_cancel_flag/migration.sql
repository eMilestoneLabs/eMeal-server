-- Live-Test-11 ISSUE-002: mark guests auto-cancelled by FR-HG-035 (host
-- flipped away from Present) so a return-to-Present inside the window can
-- restore exactly that set. Manual cancels keep FALSE and never come back.
-- Additive + idempotent.
ALTER TABLE "meal_guests" ADD COLUMN IF NOT EXISTS "autoCancelledWithHost" BOOLEAN NOT NULL DEFAULT FALSE;
