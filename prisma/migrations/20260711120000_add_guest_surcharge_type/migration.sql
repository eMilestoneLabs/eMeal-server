-- SRS Module 03 GST-011: guest surcharge supports Fixed ₹ OR Percentage.
-- Additive + nullable so existing rows are untouched (null = fixed, the
-- pre-existing behaviour).
ALTER TABLE "groups" ADD COLUMN "guestSurchargeType" TEXT;
