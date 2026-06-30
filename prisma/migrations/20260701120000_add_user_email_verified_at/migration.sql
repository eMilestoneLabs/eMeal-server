-- Additive: email verification timestamp for the Authentication & Onboarding module.
-- SRS AUTH-036/040 — account is "unverified" until Email OTP verification succeeds,
-- at which point this column is stamped with the verification time. Nullable so all
-- existing rows remain valid (treated as unverified / grandfathered). Non-breaking.
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
