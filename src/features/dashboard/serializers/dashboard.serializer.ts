/**
 * DashboardSerializer — Frontend contract serializer for B5 Dashboard.
 *
 * Contract invariants:
 *   - Counts only — no rates/percentages (Flutter computes)
 *   - generatedAt: full ISO string
 *   - attendanceSummary fields: presentDays, absentDays, skippedDays, totalDays
 *   - todayAttendance: { present, absent, pending, skipped }
 *   - mealParticipation: [{ mealId, mealName, slotKey, count }]
 *   - recentActivity: [{ type, actorName, targetName, happenedAt }]
 */

import {
  StudentDashboardEntity,
  AdminDashboardEntity,
  AttendanceAnalyticsEntity,
} from '../entities/dashboard.entity';

export class StudentDashboardSerializer {
  static toResponse(entity: StudentDashboardEntity): Record<string, unknown> {
    return {
      upcomingMeals: entity.upcomingMeals,
      todayAttendance: entity.todayAttendance,
      attendanceSummary: {
        totalDays: entity.attendanceSummary.totalDays,
        presentDays: entity.attendanceSummary.presentDays,
        absentDays: entity.attendanceSummary.absentDays,
        skippedDays: entity.attendanceSummary.skippedDays,
        vacationDays: entity.attendanceSummary.vacationDays,
      },
      activeGroups: entity.activeGroups,
      vacationMode: entity.vacationMode,
      defaultAttendanceMode: entity.defaultAttendanceMode,
      generatedAt: entity.generatedAt,
    };
  }
}

export class AdminDashboardSerializer {
  static toResponse(entity: AdminDashboardEntity): Record<string, unknown> {
    return {
      organizationId: entity.organizationId,
      groupCount: entity.groupCount,
      memberCount: entity.memberCount,
      activeMeals: entity.activeMeals,
      activeSchedules: entity.activeSchedules,
      todayAttendance: {
        present: entity.todayAttendance.present,
        absent: entity.todayAttendance.absent,
        pending: entity.todayAttendance.pending,
        skipped: entity.todayAttendance.skipped,
      },
      mealParticipation: entity.mealParticipation,
      recentActivity: entity.recentActivity,
      generatedAt: entity.generatedAt,
    };
  }
}

export class AttendanceAnalyticsSerializer {
  static toResponse(entity: AttendanceAnalyticsEntity): Record<string, unknown> {
    return {
      organizationId: entity.organizationId,
      groupId: entity.groupId,
      fromDate: entity.fromDate,
      toDate: entity.toDate,
      totalMembers: entity.totalMembers,
      dailyBreakdown: entity.dailyBreakdown,
      slotBreakdown: entity.slotBreakdown,
      generatedAt: entity.generatedAt,
    };
  }
}
