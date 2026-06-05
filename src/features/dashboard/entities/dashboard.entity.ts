/**
 * Dashboard domain entities — B5 Phase.
 *
 * Counts only — never rates/percentages.
 * Flutter computes all rates from raw counts.
 */

// ─── Student Dashboard Entity ─────────────────────────────────────────────────

export interface UpcomingMealItem {
  mealId: string;
  slotKey: string;
  displayName: string;
  attendanceWindowOpen: string | null;
  attendanceWindowClose: string | null;
  isAttended: boolean | null; // null = not yet marked
}

export interface TodayAttendanceItem {
  mealId: string;
  slotKey: string;
  displayName: string;
  status: string | null; // null = no record yet
}

export interface AttendanceSummary {
  totalDays: number;
  presentDays: number;
  absentDays: number;
  skippedDays: number;
  vacationDays: number;
}

export interface ActiveGroupItem {
  groupId: string;
  groupName: string;
  groupType: string;
  mealsEnabled: boolean;
}

// B5 Step 19: weeklyMeals item shape
export interface WeeklyMealItem {
  mealId: string;
  slotKey: string;
  displayName: string;
  date: string; // YYYY-MM-DD
  dayOfWeek: string; // "monday".."sunday"
}

// B5 Step 19: notifications item shape
export interface DashboardNotificationItem {
  id: string;
  type: string;       // "attendance_reminder" | "meal_updated" | "system"
  title: string;
  body: string;
  createdAt: string;  // ISO string
  isRead: boolean;
}

export class StudentDashboardEntity {
  userId: string;
  organizationId: string;
  upcomingMeals: UpcomingMealItem[];
  todayAttendance: TodayAttendanceItem[];
  weeklyMeals: WeeklyMealItem[];                      // B5 Step 19
  notifications: DashboardNotificationItem[];          // B5 Step 19
  attendanceSummary: AttendanceSummary;
  activeGroups: ActiveGroupItem[];
  vacationMode: boolean;
  defaultAttendanceMode: boolean;
  generatedAt: string; // ISO string

  constructor(data: {
    userId: string;
    organizationId: string;
    upcomingMeals: UpcomingMealItem[];
    todayAttendance: TodayAttendanceItem[];
    weeklyMeals?: WeeklyMealItem[];
    notifications?: DashboardNotificationItem[];
    attendanceSummary: AttendanceSummary;
    activeGroups: ActiveGroupItem[];
    vacationMode: boolean;
    defaultAttendanceMode: boolean;
    generatedAt: string;
  }) {
    this.userId = data.userId;
    this.organizationId = data.organizationId;
    this.upcomingMeals = data.upcomingMeals;
    this.todayAttendance = data.todayAttendance;
    this.weeklyMeals = data.weeklyMeals ?? [];
    this.notifications = data.notifications ?? [];
    this.attendanceSummary = data.attendanceSummary;
    this.activeGroups = data.activeGroups;
    this.vacationMode = data.vacationMode;
    this.defaultAttendanceMode = data.defaultAttendanceMode;
    this.generatedAt = data.generatedAt;
  }
}

// ─── Admin Dashboard Entity ───────────────────────────────────────────────────

export interface TodayAttendanceCounts {
  present: number;
  absent: number;
  pending: number;
  skipped: number;
}

export interface MealParticipationItem {
  mealId: string;
  mealName: string;
  slotKey: string;
  count: number; // present count for today
}

export interface RecentActivityItem {
  type: string;      // "attendance_marked" | "member_joined" | "meal_created" etc.
  actorName: string | null;
  targetName: string | null;
  happenedAt: string; // ISO string
}

export class AdminDashboardEntity {
  organizationId: string;
  groupCount: number;
  memberCount: number;
  activeMeals: number;
  activeSchedules: number;
  todayAttendance: TodayAttendanceCounts;
  mealParticipation: MealParticipationItem[];
  recentActivity: RecentActivityItem[];
  generatedAt: string;

  constructor(data: {
    organizationId: string;
    groupCount: number;
    memberCount: number;
    activeMeals: number;
    activeSchedules: number;
    todayAttendance: TodayAttendanceCounts;
    mealParticipation: MealParticipationItem[];
    recentActivity: RecentActivityItem[];
    generatedAt: string;
  }) {
    Object.assign(this, data);
  }
}

// ─── Analytics Entity ─────────────────────────────────────────────────────────

export class AttendanceAnalyticsEntity {
  organizationId: string;
  groupId: string;
  fromDate: string;
  toDate: string;
  dailyBreakdown: Array<{
    date: string;
    present: number;
    absent: number;
    skipped: number;
    onVacation: number;
  }>;
  slotBreakdown: Array<{
    slotKey: string;
    displayName: string;
    present: number;
    absent: number;
    skipped: number;
  }>;
  totalMembers: number;
  generatedAt: string;

  constructor(data: {
    organizationId: string;
    groupId: string;
    fromDate: string;
    toDate: string;
    dailyBreakdown: AttendanceAnalyticsEntity['dailyBreakdown'];
    slotBreakdown: AttendanceAnalyticsEntity['slotBreakdown'];
    totalMembers: number;
    generatedAt: string;
  }) {
    Object.assign(this, data);
  }
}
