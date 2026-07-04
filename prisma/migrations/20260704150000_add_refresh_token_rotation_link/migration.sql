-- Rotation lineage for refresh tokens (mobile lost-response rescue).
-- usedAt: when the token was redeemed for a successor.
-- replacedById: id of the successor token issued at rotation.
-- A revoked token whose successor was never used = lost rotation response,
-- rescued in-family instead of tripping theft detection.
ALTER TABLE "refresh_tokens"
  ADD COLUMN "usedAt" TIMESTAMP(3),
  ADD COLUMN "replacedById" TEXT;
