-- NTF-006 (Module 02): per-member bell dismissal. Additive + nullable so
-- existing reads and the shared-notice model are untouched.
ALTER TABLE "notice_reads" ADD COLUMN "dismissedAt" TIMESTAMP(3);
