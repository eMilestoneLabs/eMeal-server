-- Issue 1: preserve the last published schedule separately from the draft.
ALTER TABLE "meal_schedules" ADD COLUMN "publishedSnapshot" JSONB;
