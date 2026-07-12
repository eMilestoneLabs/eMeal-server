-- SRS Module 03 NTC-003/012/013: notice rich content — one optional image
-- (≤100 KB), one optional document (≤50 KB) stored as MinIO object URLs, and
-- optional external links. Additive + nullable/defaulted.
ALTER TABLE "notices" ADD COLUMN "imageUrl" TEXT;
ALTER TABLE "notices" ADD COLUMN "documentUrl" TEXT;
ALTER TABLE "notices" ADD COLUMN "documentName" TEXT;
ALTER TABLE "notices" ADD COLUMN "externalLinks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
