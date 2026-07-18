/**
 * AttendanceSerializer — Frontend contract serializer for B4.
 *
 * CONTRACT (from Flutter AttendanceModel.fromJson — LOCKED):
 *   - date: YYYY-MM-DD string (NOT full ISO DateTime) — Flutter reads json['date']
 *   - mealName: JOIN from meal.name — always flat field at root (M-10)
 *   - organizationId: included in full response
 *   - status: raw string ("present" | "absent" | "skipped" | "onVacation")
 *   - markedAt: full ISO string or null
 *   - note: null allowed (M-10)
 *   - preference: null allowed
 *
 * AttendanceSummary CONTRACT:
 *   - presentDays, absentDays, skippedDays (NOT presentCount/absentCount)
 *   - Flutter computes rate — backend never returns rate/percentage
 */

import {
  AttendanceEntity,
  AttendanceSummaryEntity,
  MealAttendanceSummaryEntity,
} from '../entities/attendance.entity';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Converts a Date to YYYY-MM-DD using UTC components. No library needed. */
function toDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── AttendanceSerializer ──────────────────────────────────────────────────

export class AttendanceSerializer {
  /**
   * Serialize a single AttendanceEntity to Flutter-safe JSON.
   * Shape mirrors Flutter AttendanceModel.fromJson exactly.
   */
  static toResponse(record: AttendanceEntity): Record<string, unknown> {
    // mealName: flat field — JOIN from meal (M-10 fix)
    const mealName = record.meal
      ? (record.meal.displayName ?? record.meal.name ?? '')
      : '';

    return {
      id: record.id,
      groupId: record.groupId,
      userId: record.userId,
      mealId: record.mealId,
      organizationId: record.organizationId,

      // Additive (Issues #4/#7/#11): joined member identity for admin-facing
      // lists, dashboard activity and exports. Null when the user relation was
      // not included (e.g. a user's own records). Existing clients ignore it.
      userName: record.user?.name ?? null,
      userEmail: record.user?.email ?? null,
      userPhone: record.user?.phone ?? null,
      // Live-Test-9 ISSUE-4.5 (additive): role + mark source so admin rosters
      // can order Admin/Manager first and auto-marked rows by name.
      userRole: (record.user as any)?.role ?? null,
      source: record.source ?? null,

      // M-10 fix: Flutter reads json['date'] — YYYY-MM-DD string
      date: toDateString(record.attendanceDate),

      status: record.status,
      preference: record.preference ?? null,
      // Module 36 (FR-PG-013): multi-group selection snapshot (null = legacy).
      preferences: record.preferences ?? null,
      note: record.note ?? null,
      markedAt: record.markedAt ? record.markedAt.toISOString() : null,
      markedBy: record.markedBy ?? null,
      price: record.price ?? null,
      // Live-Test-11 ISSUE-017 (additive): per-record Bill-Absent snapshot so
      // clients label billed absents exactly like the server engine bills them.
      billAbsent: record.billAbsent ?? null,

      // M-10 fix: mealName always present as flat field
      mealName,

      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Serialize array of records.
   */
  static toList(records: AttendanceEntity[]): Record<string, unknown>[] {
    return records.map((r) => AttendanceSerializer.toResponse(r));
  }

  /**
   * Serialize the minimal response returned when marking attendance.
   * Keeps payload small for Flutter's POST /attendance response.
   */
  static toMarkResponse(record: AttendanceEntity): Record<string, unknown> {
    return {
      id: record.id,
      mealId: record.mealId,
      // Flutter reads json['date']
      date: toDateString(record.attendanceDate),
      status: record.status,
      preference: record.preference ?? null,
      // Module 36 (FR-PG-013): multi-group selection snapshot (null = legacy).
      preferences: record.preferences ?? null,
      price: record.price ?? null,
      // ISSUE-017 (additive): per-record Bill-Absent snapshot.
      billAbsent: record.billAbsent ?? null,
      markedAt: record.markedAt ? record.markedAt.toISOString() : null,
      // Module 33 consent trail (additive — FR-TRUST-010 groundwork).
      source: record.source ?? null,
      sourceRequestId: record.sourceRequestId ?? null,
    };
  }
}

// ─── AttendanceSummarySerializer ───────────────────────────────────────────

export class AttendanceSummarySerializer {
  /**
   * Serialize a user's attendance summary.
   *
   * CRITICAL: Flutter reads:
   *   json['presentDays'] (NOT presentCount)
   *   json['absentDays']  (NOT absentCount)
   *   json['skippedDays'] (NOT skippedCount)
   * No rates/percentages — Flutter computes those from raw counts.
   */
  static toResponse(summary: AttendanceSummaryEntity): Record<string, unknown> {
    const base: Record<string, unknown> = {
      userId: summary.userId,
      groupId: summary.groupId,
      fromDate: summary.fromDate,
      toDate: summary.toDate,
      totalDays: summary.totalDays,
      // Flutter reads presentDays / absentDays / skippedDays
      presentDays: summary.presentCount,
      absentDays: summary.absentCount,
      skippedDays: summary.skippedCount,
    };

    // Include meal breakdown only when requested (admin reports)
    if (summary.mealBreakdown) {
      base.mealBreakdown = Object.values(summary.mealBreakdown);
    }

    return base;
  }
}

// ─── MealAttendanceSummarySerializer ───────────────────────────────────────

export class MealAttendanceSummarySerializer {
  /**
   * Serialize a meal's attendance summary for admin dashboard.
   */
  static toResponse(
    summary: MealAttendanceSummaryEntity,
  ): Record<string, unknown> {
    return {
      mealId: summary.mealId,
      slotKey: summary.slotKey,
      mealName: summary.displayName,
      date: summary.attendanceDate,
      totalMembers: summary.totalMembers,
      presentDays: summary.presentCount,
      absentDays: summary.absentCount,
      skippedDays: summary.skippedCount,
      snapshotPrice: summary.snapshotPrice ?? null,
      preferenceBreakdown: summary.preferenceBreakdown ?? {},
      preferenceGroupBreakdown: summary.preferenceGroupBreakdown ?? {},
      // ISSUE-016 (additive): headcount validation source for qty groups.
      preferenceGroupPickCounts: summary.preferenceGroupPickCounts ?? {},
    };
  }

  static toList(
    summaries: MealAttendanceSummaryEntity[],
  ): Record<string, unknown>[] {
    return summaries.map((s) =>
      MealAttendanceSummarySerializer.toResponse(s),
    );
  }
}
