/**
 * AttendanceEntity — Domain entity. Decoupled from Prisma model.
 *
 * Key B4 invariants:
 *   - attendanceDate: DateTime stored as UTC midnight
 *   - status: present | absent | skipped | onVacation (default = present)
 *   - markedBy: nullable userId (replaces markedByAdmin + adminId)
 *   - meal: optional joined relation (for serialization only)
 */
export class AttendanceEntity {
  id: string;
  organizationId: string;
  groupId: string;
  userId: string;
  mealId: string;

  attendanceDate: Date;
  status: string; // AttendanceStatus enum value as string

  preference: string | null;
  // Module 36 (FR-PG-013): immutable multi-group selection snapshot
  // [{groupId,groupLabel,optionKey,optionLabel,isVeg,priceDelta,quantity}].
  preferences?: unknown;
  note: string | null;
  markedAt: Date | null;
  markedBy: string | null; // userId of admin who performed manual override
  // Additive: ₹ price snapshot at mark time (per-day override or master meal price).
  price: number | null;

  // Module 33 consent trail — how this record came to exist:
  // self | default | system_default | admin | request | verified
  source?: string | null;
  // AttendanceCorrectionRequest id that produced this record (consent proof)
  sourceRequestId?: string | null;

  createdAt: Date;
  updatedAt: Date;

  // Optional joined relation — loaded by serializer when present
  meal?: {
    slotKey: string;
    displayName: string | null;
    name: string;
    attendanceWindowOpen: string | null;
    attendanceWindowClose: string | null;
  } | null;

  // Optional joined user — for admin-facing responses
  user?: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    avatarUrl: string | null;
  } | null;

  constructor(data: Partial<AttendanceEntity>) {
    Object.assign(this, data);
  }
}

/**
 * AttendanceSummaryEntity — Aggregated counts for a user/group/meal.
 * CRITICAL: No rates or percentages — Flutter computes those from raw counts.
 */
export class AttendanceSummaryEntity {
  userId: string;
  groupId: string;
  organizationId: string;

  // Date range
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD

  // Raw counts only — Flutter computes percentages
  totalDays: number;
  presentCount: number;
  absentCount: number;
  skippedCount: number;
  onVacationCount: number;

  // Optional per-meal breakdown (key = mealId)
  mealBreakdown?: Record<string, {
    mealId: string;
    slotKey: string;
    displayName: string;
    presentCount: number;
    absentCount: number;
    skippedCount: number;
  }>;

  constructor(data: Partial<AttendanceSummaryEntity>) {
    Object.assign(this, data);
  }
}

/**
 * MealAttendanceSummaryEntity — Per-meal aggregate for admin dashboard.
 * Shows how many students chose each status/preference for a meal on a date.
 */
export class MealAttendanceSummaryEntity {
  mealId: string;
  slotKey: string;
  displayName: string;
  attendanceDate: string; // YYYY-MM-DD

  totalMembers: number;
  presentCount: number;
  absentCount: number;
  skippedCount: number;

  // Issue 1: snapshot unit price actually billed for present records on this
  // meal+date (null when pricing is off or nobody marked present). The admin
  // dashboard prefers this over the live Meal.price so editing a closed meal's
  // price never rewrites what today already displayed.
  snapshotPrice?: number | null;

  // Preference breakdown (only populated when meal has preferencesEnabled)
  preferenceBreakdown: Record<string, number>; // { "veg": 5, "chicken": 3, ... }

  // Module 36 (FR-PG-050): multi-preference-group selections of present members,
  // keyed by snapshotted labels: { "Roti/Rice": { "Roti": 4, "Rice": 2 } }.
  // Empty for groups using only the legacy flat preference (additive).
  preferenceGroupBreakdown?: Record<string, Record<string, number>>;

  constructor(data: Partial<MealAttendanceSummaryEntity>) {
    Object.assign(this, data);
  }
}
