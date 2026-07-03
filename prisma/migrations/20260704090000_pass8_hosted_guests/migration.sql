-- Pass 8 (Module 22 — Member-Hosted Guests). Additive only.

-- FR-HG-020: per-group guest configuration (defaults keep feature OFF).
ALTER TABLE "groups" ADD COLUMN "guestAttendanceEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "groups" ADD COLUMN "maxGuestsPerMemberPerMeal" INTEGER;
ALTER TABLE "groups" ADD COLUMN "maxGuestsPerMemberPerDay" INTEGER;
ALTER TABLE "groups" ADD COLUMN "guestPricingMode" TEXT;
ALTER TABLE "groups" ADD COLUMN "guestAdultPrice" INTEGER;
ALTER TABLE "groups" ADD COLUMN "guestChildPrice" INTEGER;
ALTER TABLE "groups" ADD COLUMN "guestSurcharge" INTEGER;
ALTER TABLE "groups" ADD COLUMN "guestRequiresApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "groups" ADD COLUMN "guestCutoffMinutesBeforeClose" INTEGER;
ALTER TABLE "groups" ADD COLUMN "guestAdvanceBookingDays" INTEGER;
ALTER TABLE "groups" ADD COLUMN "guestPreferenceRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "groups" ADD COLUMN "allowGuestWithoutHost" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "groups" ADD COLUMN "billNoShowGuests" BOOLEAN NOT NULL DEFAULT true;

-- FR-HG-012: denormalised host counters on the attendance record.
ALTER TABLE "attendance_records" ADD COLUMN "guestAdults" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "attendance_records" ADD COLUMN "guestChildren" INTEGER NOT NULL DEFAULT 0;

-- FR-HG-010/011: MealGuest table + query indexes.
CREATE TABLE "meal_guests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "attendanceDate" TIMESTAMP(3) NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "isAdult" BOOLEAN NOT NULL DEFAULT true,
    "displayName" TEXT,
    "mealPreference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "pendingApproval" BOOLEAN NOT NULL DEFAULT false,
    "priceSnapshot" INTEGER,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_guests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meal_guests_groupId_attendanceDate_idx" ON "meal_guests"("groupId", "attendanceDate");
CREATE INDEX "meal_guests_hostUserId_attendanceDate_idx" ON "meal_guests"("hostUserId", "attendanceDate");
CREATE INDEX "meal_guests_mealId_attendanceDate_idx" ON "meal_guests"("mealId", "attendanceDate");
CREATE INDEX "meal_guests_organizationId_idx" ON "meal_guests"("organizationId");
