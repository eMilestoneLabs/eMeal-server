-- Module 33 (MIG-010/MIG-011): Attendance Correction Requests — the
-- member-initiated consent path (FR-ACR-*) + consent-trail columns on
-- attendance_records. Purely additive: new table + nullable/defaulted columns.
-- No existing column, contract, or the attendance idempotency key is touched.

-- CreateTable
CREATE TABLE "attendance_correction_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "attendanceDate" TIMESTAMP(3) NOT NULL,
    "requestType" TEXT NOT NULL,
    "requestedStatus" TEXT,
    "requestedPreference" TEXT,
    "reason" TEXT,
    "evidenceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "sourceChannel" TEXT NOT NULL DEFAULT 'member',
    "resultRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_correction_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_correction_requests_groupId_status_idx" ON "attendance_correction_requests"("groupId", "status");

-- CreateIndex
CREATE INDEX "attendance_correction_requests_userId_attendanceDate_idx" ON "attendance_correction_requests"("userId", "attendanceDate");

-- CreateIndex
CREATE INDEX "attendance_correction_requests_organizationId_idx" ON "attendance_correction_requests"("organizationId");

-- CreateIndex
CREATE INDEX "attendance_correction_requests_status_expiresAt_idx" ON "attendance_correction_requests"("status", "expiresAt");

-- AlterTable (additive consent trail — defaults safe, no backfill needed:
-- existing records read as source='self', sourceRequestId=NULL)
ALTER TABLE "attendance_records" ADD COLUMN "source" TEXT DEFAULT 'self';
ALTER TABLE "attendance_records" ADD COLUMN "sourceRequestId" TEXT;
