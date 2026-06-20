-- Additive: snapshot the effective ₹ price (per-day override or master) onto each
-- attendance record at mark time, so billing/exports reflect the day's price.
ALTER TABLE "attendance_records" ADD COLUMN "price" INTEGER;
