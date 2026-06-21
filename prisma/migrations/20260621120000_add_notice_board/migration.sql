-- CreateTable
CREATE TABLE "notices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "createdBy" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_reads" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notices_organizationId_idx" ON "notices"("organizationId");

-- CreateIndex
CREATE INDEX "notices_groupId_idx" ON "notices"("groupId");

-- CreateIndex
CREATE INDEX "notices_organizationId_isActive_idx" ON "notices"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "notices_expiresAt_idx" ON "notices"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "notice_reads_noticeId_userId_key" ON "notice_reads"("noticeId", "userId");

-- CreateIndex
CREATE INDEX "notice_reads_userId_idx" ON "notice_reads"("userId");

-- AddForeignKey
ALTER TABLE "notice_reads" ADD CONSTRAINT "notice_reads_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
