-- SRS Pass 6 (FR-TIME-005, LOOP-090): per-group attendance grace period.
-- Additive, nullable — existing groups keep exact current behaviour (no grace).
ALTER TABLE "groups" ADD COLUMN "attendanceGraceMinutes" INTEGER;
