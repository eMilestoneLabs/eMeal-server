-- SRS Module 03 (survey Q17/Q22): per-group "Bill Skip" policy. When ON,
-- member-chosen Absent and system-generated Skip are billed at the final
-- scheduled price. Default FALSE preserves live behaviour exactly.
ALTER TABLE "groups" ADD COLUMN "billSkippedMeals" BOOLEAN NOT NULL DEFAULT false;
