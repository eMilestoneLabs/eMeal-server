/**
 * dashboard.serializer.spec.ts — B5 Phase
 *
 * Contract tests for StudentDashboardSerializer and AdminDashboardSerializer.
 *
 * Rules:
 *   - Counts only — no rates/percentages
 *   - attendanceSummary uses: presentDays, absentDays, skippedDays (not rates)
 *   - todayAttendance: { present, absent, pending, skipped }
 *   - mealParticipation: [{ mealId, mealName, slotKey, count }]
 */

import { StudentDashboardSerializer, AdminDashboardSerializer } from '../serializers/dashboard.serializer';
import { StudentDashboardEntity, AdminDashboardEntity } from '../entities/dashboard.entity';

const now = new Date().toISOString();

const mockStudentDashboard = new StudentDashboardEntity({
  userId: 'user-1',
  organizationId: 'org-1',
  upcomingMeals: [
    {
      mealId: 'meal-1',
      slotKey: 'lunch',
      displayName: 'Lunch',
      attendanceWindowOpen: '12:00',
      attendanceWindowClose: '13:00',
      isAttended: null,
    },
  ],
  todayAttendance: [
    {
      mealId: 'meal-1',
      slotKey: 'lunch',
      displayName: 'Lunch',
      status: null,
    },
  ],
  attendanceSummary: {
    totalDays: 30,
    presentDays: 25,
    absentDays: 3,
    skippedDays: 2,
    vacationDays: 0,
  },
  activeGroups: [
    { groupId: 'g-1', groupName: 'Hostel A', groupType: 'hostel', mealsEnabled: true },
  ],
  vacationMode: false,
  defaultAttendanceMode: false,
  generatedAt: now,
});

const mockAdminDashboard = new AdminDashboardEntity({
  organizationId: 'org-1',
  groupCount: 5,
  memberCount: 120,
  activeMeals: 8,
  activeSchedules: 3,
  todayAttendance: {
    present: 90,
    absent: 15,
    pending: 15,
    skipped: 0,
  },
  mealParticipation: [
    { mealId: 'meal-1', mealName: 'Breakfast', slotKey: 'breakfast', count: 45 },
  ],
  recentActivity: [
    { type: 'create', actorName: 'Admin', targetName: 'Meal', happenedAt: now },
  ],
  generatedAt: now,
});

describe('StudentDashboardSerializer', () => {
  it('serializes all required fields', () => {
    const result = StudentDashboardSerializer.toResponse(mockStudentDashboard);

    expect(result).toHaveProperty('upcomingMeals');
    expect(result).toHaveProperty('todayAttendance');
    expect(result).toHaveProperty('attendanceSummary');
    expect(result).toHaveProperty('activeGroups');
    expect(result).toHaveProperty('vacationMode', false);
    expect(result).toHaveProperty('defaultAttendanceMode', false);
    expect(result).toHaveProperty('generatedAt');
  });

  it('attendanceSummary uses count fields, not rates', () => {
    const result = StudentDashboardSerializer.toResponse(mockStudentDashboard);
    const summary = result.attendanceSummary as any;

    expect(summary).toHaveProperty('totalDays', 30);
    expect(summary).toHaveProperty('presentDays', 25);
    expect(summary).toHaveProperty('absentDays', 3);
    expect(summary).toHaveProperty('skippedDays', 2);

    // No rates
    expect(summary).not.toHaveProperty('attendanceRate');
    expect(summary).not.toHaveProperty('presentRate');
    expect(summary).not.toHaveProperty('percentage');
  });
});

describe('AdminDashboardSerializer', () => {
  it('serializes all required fields', () => {
    const result = AdminDashboardSerializer.toResponse(mockAdminDashboard);

    expect(result).toHaveProperty('organizationId', 'org-1');
    expect(result).toHaveProperty('groupCount', 5);
    expect(result).toHaveProperty('memberCount', 120);
    expect(result).toHaveProperty('activeMeals', 8);
    expect(result).toHaveProperty('activeSchedules', 3);
    expect(result).toHaveProperty('todayAttendance');
    expect(result).toHaveProperty('mealParticipation');
    expect(result).toHaveProperty('recentActivity');
    expect(result).toHaveProperty('generatedAt');
  });

  it('todayAttendance has required count fields', () => {
    const result = AdminDashboardSerializer.toResponse(mockAdminDashboard);
    const today = result.todayAttendance as any;

    expect(today).toHaveProperty('present', 90);
    expect(today).toHaveProperty('absent', 15);
    expect(today).toHaveProperty('pending', 15);
    expect(today).toHaveProperty('skipped', 0);

    // No rates
    expect(today).not.toHaveProperty('presentRate');
    expect(today).not.toHaveProperty('percentage');
  });

  it('mealParticipation items have correct fields', () => {
    const result = AdminDashboardSerializer.toResponse(mockAdminDashboard);
    const participation = result.mealParticipation as any[];

    expect(participation).toHaveLength(1);
    expect(participation[0]).toHaveProperty('mealId', 'meal-1');
    expect(participation[0]).toHaveProperty('mealName', 'Breakfast');
    expect(participation[0]).toHaveProperty('slotKey', 'breakfast');
    expect(participation[0]).toHaveProperty('count', 45);
  });
});
