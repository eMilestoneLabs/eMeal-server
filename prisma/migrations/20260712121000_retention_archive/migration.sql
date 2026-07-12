-- SRS Module 03 RET-001..015 / RPT-009..011: rolling 3-month retention.
-- Group gains the next-review pointer; group_archives records every
-- pre-purge Excel/PDF archive (the admin's permanent copy).
ALTER TABLE "groups" ADD COLUMN "retentionReviewAt" TIMESTAMP(3);

CREATE TABLE "group_archives" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "excelUrl" TEXT NOT NULL,
    "pdfUrl" TEXT,
    "recordCounts" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "group_archives_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "group_archives_organizationId_idx" ON "group_archives"("organizationId");
CREATE INDEX "group_archives_groupId_generatedAt_idx" ON "group_archives"("groupId", "generatedAt");
