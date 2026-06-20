-- Additive: meal pricing support (all additive, nullable/defaulted — no breaking change).
-- Group toggle: when ON, meals carry a ₹ price shown to students + used for billing/exports.
ALTER TABLE "groups" ADD COLUMN "mealPricingEnabled" BOOLEAN NOT NULL DEFAULT false;
-- Master meal price (₹). NULL when pricing disabled or unset.
ALTER TABLE "meals" ADD COLUMN "price" INTEGER;
-- Per-day price override (₹). NULL = inherit master Meal.price.
ALTER TABLE "schedule_entries" ADD COLUMN "price" INTEGER;
