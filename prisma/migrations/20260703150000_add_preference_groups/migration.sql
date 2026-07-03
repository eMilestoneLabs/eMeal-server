-- Module 36 (FR-PG-*): Multi-dimensional preference groups — a meal supports
-- N choice dimensions (Staple, Non-Veg, …), each with its own pick rule and
-- priced options; a member's selection is stored as snapshotted child rows +
-- an immutable JSON mirror on attendance_records.preferences.
-- Purely additive: new tables + one nullable JSON column. Legacy flat
-- Meal.enabledPreferences[] and AttendanceRecord.preference are untouched
-- and remain fully functional (FR-PG-021/100).

-- AlterTable
ALTER TABLE "attendance_records" ADD COLUMN "preferences" JSONB;

-- CreateTable
CREATE TABLE "preference_groups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'group',
    "label" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "selectionType" TEXT NOT NULL DEFAULT 'single',
    "minSelect" INTEGER NOT NULL DEFAULT 1,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "quantityEnabled" BOOLEAN NOT NULL DEFAULT false,
    "visibleWhen" JSONB,
    "vegOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preference_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preference_options" (
    "id" TEXT NOT NULL,
    "preferenceGroupId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT,
    "color" TEXT,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "priceDelta" INTEGER NOT NULL DEFAULT 0,
    "minQty" INTEGER NOT NULL DEFAULT 1,
    "maxQty" INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preference_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_preference_groups" (
    "id" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "preferenceGroupId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "requiredOverride" BOOLEAN,
    "minSelectOverride" INTEGER,
    "maxSelectOverride" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meal_preference_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_preference_selections" (
    "id" TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "preferenceGroupId" TEXT NOT NULL,
    "groupLabelSnapshot" TEXT NOT NULL,
    "optionKey" TEXT NOT NULL,
    "optionLabelSnapshot" TEXT NOT NULL,
    "isVegSnapshot" BOOLEAN NOT NULL DEFAULT true,
    "priceDeltaSnapshot" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_preference_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "preference_groups_organizationId_idx" ON "preference_groups"("organizationId");
CREATE INDEX "preference_groups_groupId_isActive_idx" ON "preference_groups"("groupId", "isActive");
CREATE UNIQUE INDEX "preference_options_preferenceGroupId_key_key" ON "preference_options"("preferenceGroupId", "key");
CREATE INDEX "preference_options_preferenceGroupId_isActive_idx" ON "preference_options"("preferenceGroupId", "isActive");
CREATE UNIQUE INDEX "meal_preference_groups_mealId_preferenceGroupId_key" ON "meal_preference_groups"("mealId", "preferenceGroupId");
CREATE INDEX "meal_preference_groups_mealId_idx" ON "meal_preference_groups"("mealId");
CREATE INDEX "attendance_preference_selections_attendanceRecordId_idx" ON "attendance_preference_selections"("attendanceRecordId");
CREATE INDEX "attendance_preference_selections_preferenceGroupId_optionK_idx" ON "attendance_preference_selections"("preferenceGroupId", "optionKey");

-- AddForeignKey
ALTER TABLE "preference_options" ADD CONSTRAINT "preference_options_preferenceGroupId_fkey" FOREIGN KEY ("preferenceGroupId") REFERENCES "preference_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meal_preference_groups" ADD CONSTRAINT "meal_preference_groups_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "meals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meal_preference_groups" ADD CONSTRAINT "meal_preference_groups_preferenceGroupId_fkey" FOREIGN KEY ("preferenceGroupId") REFERENCES "preference_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_preference_selections" ADD CONSTRAINT "attendance_preference_selections_attendanceRecordId_fkey" FOREIGN KEY ("attendanceRecordId") REFERENCES "attendance_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
