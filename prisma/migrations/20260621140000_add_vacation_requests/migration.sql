-- CreateTable
CREATE TABLE "vacation_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "vacation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vacation_requests_organizationId_idx" ON "vacation_requests"("organizationId");

-- CreateIndex
CREATE INDEX "vacation_requests_userId_idx" ON "vacation_requests"("userId");

-- CreateIndex
CREATE INDEX "vacation_requests_groupId_idx" ON "vacation_requests"("groupId");

-- CreateIndex
CREATE INDEX "vacation_requests_organizationId_status_idx" ON "vacation_requests"("organizationId", "status");
