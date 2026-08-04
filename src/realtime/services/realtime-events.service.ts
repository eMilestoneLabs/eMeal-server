import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { AttendanceGateway } from '../gateway/attendance.gateway';

/**
 * RealtimeEventsService — unified typed event emitter for all realtime events.
 *
 * This service is the ONLY interface other feature modules should use to emit
 * WebSocket events. It isolates feature modules from the gateway implementation.
 *
 * All methods are no-ops if gateway is not connected (prevents DI errors in tests).
 *
 * ── B7 events (versioned, additive-safe) ───────────────────────────────────
 *   attendance.marked.v1           — first-time attendance mark
 *   attendance.updated.v1          — admin override / re-mark
 *   meal.updated.v1                — meal config changed
 *   meal.published.v1              — meal activated for the day
 *   schedule.updated.v1            — schedule created or entries modified
 *   schedule.published.v1          — schedule published to students
 *   dashboard.summary.updated.v1   — admin/student dashboard cache bust
 *   member.blocked.v1              — member blocked by admin
 *   group.member.updated.v1        — member joined / removed / role changed
 *
 * ── B5 dashboard/analytics events ─────────────────────────────────────────
 *   dashboard.updated.v1           — dashboard data changed (full refresh signal)
 *   analytics.updated.v1           — analytics aggregates changed
 *   event.updated.v1               — event data changed
 *   event.stats.updated.v1         — event statistics changed (guest count, etc.)
 *   attendance.analytics.updated.v1 — attendance analytics cache invalidated
 */

// ── Payload types (frontend-contract-locked shapes) ───────────────────────────

export interface AttendanceMarkedPayload {
  groupId: string;
  userId: string;
  mealId: string;
  date: string;         // YYYY-MM-DD — Flutter reads json['date']
  status: string;       // present | absent | skipped
  preference: string | null;
  markedAt: string;     // ISO
}

export interface AttendanceUpdatedPayload extends AttendanceMarkedPayload {
  markedBy: string | null; // admin override — admin userId
}

export interface MealUpdatedPayload {
  organizationId: string;
  groupId: string;
  mealId: string;
  isActive: boolean;
  slotKey: string;
}

export interface MealPublishedPayload {
  organizationId: string;
  groupId: string;
  mealId: string;
  slotKey: string;
  date: string; // YYYY-MM-DD
}

export interface ScheduleUpdatedPayload {
  organizationId: string;
  groupId: string;
  scheduleId: string;
  weekStart: string; // ISO date string
  isPublished: boolean;
}

export interface DashboardSummaryUpdatedPayload {
  organizationId: string;
  groupId: string;
  date: string; // YYYY-MM-DD — which date's summary changed
}

export interface MemberBlockedPayload {
  groupId: string;
  userId: string;        // blocked user
  blockedBy: string;     // admin userId
  reason?: string | null;
}

export interface GroupMemberUpdatedPayload {
  groupId: string;
  userId: string;
  action: 'joined' | 'left' | 'removed' | 'blocked' | 'unblocked' | 'role_changed';
}

// ── B5 payload types ──────────────────────────────────────────────────────────

export interface DashboardUpdatedPayload {
  organizationId: string;
  userId?: string;   // if null = all users in org; if set = specific user
  reason: string;    // "attendance_marked" | "meal_updated" | "member_joined" | etc.
}

export interface AnalyticsUpdatedPayload {
  organizationId: string;
  groupId?: string;
  type: string; // "attendance" | "meal" | "organization" | "group"
}

export interface EventUpdatedPayload {
  organizationId: string;
  eventId: string;
  action: string; // "created" | "updated" | "deleted" | "guest_joined"
}

export interface EventStatsUpdatedPayload {
  organizationId: string;
  eventId: string;
  total: number;
  adults: number;
  children: number;
  pending: number;
}

export interface AttendanceAnalyticsUpdatedPayload {
  organizationId: string;
  groupId: string;
  date: string; // YYYY-MM-DD
}

// GAP-WS-1 (RESOLVED): events named in the source-of-truth requirements.
// Additive — emitted ALONGSIDE the existing attendance.updated.v1 /
// event.stats.updated.v1 emits so no existing listener breaks.

export interface AttendanceOverriddenPayload extends AttendanceMarkedPayload {
  markedBy: string; // admin userId who performed the override
  previousStatus?: string | null;
}

export interface GuestJoinedPayload {
  organizationId: string;
  eventId: string;
  partyId: string;
  primaryName: string;
  adultsCount: number;
  childrenCount: number;
}

export interface GuestUpdatedPayload {
  organizationId: string;
  eventId: string;
  partyId: string;
  action: string; // "renamed" | "presence_changed" | "meal_changed" | "party_updated" | "party_removed"
  personId?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

/** Phase B: notice board — a new notice was posted. */
export interface NoticeCreatedPayload {
  organizationId: string;
  groupId: string | null;
  noticeId: string;
  title: string;
  priority: string;
  pinned: boolean;
  publishedAt: string; // ISO-8601
  // #4: 'all' | 'admins' | 'members' — lets a client ignore events not meant
  // for it. Optional/additive; legacy notice.created emits omit it (= 'all').
  audience?: string;
}

@Injectable()
export class RealtimeEventsService {
  private readonly logger = new Logger(RealtimeEventsService.name);

  constructor(
    @Optional()
    @Inject('ATTENDANCE_GATEWAY')
    private readonly gateway: AttendanceGateway | null,
  ) {}

  private get isReady(): boolean {
    return this.gateway != null;
  }

  // ── Attendance events ─────────────────────────────────────────────────────

  emitAttendanceMarked(groupId: string, payload: AttendanceMarkedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'attendance.marked.v1', payload);
    this.logger.debug(`attendance.marked.v1 → group:${groupId} userId=${payload.userId}`);
  }

  emitAttendanceUpdated(groupId: string, payload: AttendanceUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'attendance.updated.v1', payload);
    this.logger.debug(`attendance.updated.v1 → group:${groupId} userId=${payload.userId}`);
  }

  // ── Meal events ───────────────────────────────────────────────────────────

  emitMealUpdated(organizationId: string, payload: MealUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToOrg(organizationId, 'meal.updated.v1', payload);
    this.logger.debug(`meal.updated.v1 → org:${organizationId} mealId=${payload.mealId}`);
  }

  emitMealPublished(groupId: string, organizationId: string, payload: MealPublishedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'meal.published.v1', payload);
    this.logger.debug(`meal.published.v1 → group:${groupId} mealId=${payload.mealId}`);
  }

  // ── Schedule events ───────────────────────────────────────────────────────

  emitScheduleUpdated(organizationId: string, payload: ScheduleUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'schedule.updated.v1', payload);
    this.logger.debug(`schedule.updated.v1 → admin:${organizationId}`);
  }

  emitSchedulePublished(groupId: string, organizationId: string, payload: ScheduleUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'schedule.published.v1', payload);
    this.gateway!.emitToAdmin(organizationId, 'schedule.published.v1', payload);
    this.logger.debug(`schedule.published.v1 → group:${groupId} + admin:${organizationId}`);
  }

  // ── Dashboard summary event ───────────────────────────────────────────────

  emitDashboardSummaryUpdated(
    organizationId: string,
    groupId: string,
    payload: DashboardSummaryUpdatedPayload,
  ): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'dashboard.summary.updated.v1', payload);
    this.gateway!.emitToAdmin(organizationId, 'dashboard.summary.updated.v1', payload);
    this.logger.debug(`dashboard.summary.updated.v1 → group:${groupId}`);
  }

  // ── Member events ─────────────────────────────────────────────────────────

  emitMemberBlocked(groupId: string, payload: MemberBlockedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'member.blocked.v1', payload);
    this.gateway!.emitToUser(payload.userId, 'member.blocked.v1', payload);
    this.logger.debug(`member.blocked.v1 → group:${groupId} userId=${payload.userId}`);
  }

  emitGroupMemberUpdated(groupId: string, payload: GroupMemberUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'group.member.updated.v1', payload);
    // Live-Test-17 JOIN-01: the AFFECTED member must also receive this in their
    // OWN room. A member whose join was just approved is by definition NOT in
    // `group:{groupId}` yet — `AttendanceGateway.handleJoinGroup` requires an
    // ACTIVE membership, which is exactly what this event announces. Without
    // the personal room the one person who most needs the transition is the
    // only one who never learns about it, and their app stays on the
    // "not joined" screen until it is manually rebuilt.
    //
    // Same shape as `emitMemberBlocked` above (group room + user room), same
    // payload, so no existing subscriber sees anything new: a socket in BOTH
    // rooms simply receives the frame twice and every consumer is debounced.
    this.gateway!.emitToUser(payload.userId, 'group.member.updated.v1', payload);
    this.logger.debug(`group.member.updated.v1 → group:${groupId} + user:${payload.userId} action=${payload.action}`);
  }

  /**
   * SRS FR-MODE-012 (Pass 6): meal-config / mode change pushed to the group
   * room so student dashboards drop or add meal widgets in real time when an
   * admin flips the mode mid-session — no stale meal UI, no stale actions.
   */
  emitGroupConfigUpdated(
    groupId: string,
    payload: { groupId: string; changes: Record<string, unknown> },
  ): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'group.config.updated.v1', payload);
    this.logger.debug(`group.config.updated.v1 → group:${groupId}`);
  }

  // ── B5 Dashboard/Analytics/Event events ──────────────────────────────────

  /**
   * B5 Step 26: dashboard.updated.v1
   * Emitted when any dashboard data changes (not just summary — full refresh signal).
   * Admin room + optional specific user room.
   */
  emitDashboardUpdated(organizationId: string, payload: DashboardUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'dashboard.updated.v1', payload);
    if (payload.userId) {
      this.gateway!.emitToUser(payload.userId, 'dashboard.updated.v1', payload);
    }
    this.logger.debug(`dashboard.updated.v1 → org:${organizationId} reason=${payload.reason}`);
  }

  /**
   * B5 Step 26: analytics.updated.v1
   * Emitted when analytics aggregates are invalidated (attendance/meal/org changes).
   * Admin room only.
   */
  emitAnalyticsUpdated(organizationId: string, payload: AnalyticsUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'analytics.updated.v1', payload);
    this.logger.debug(`analytics.updated.v1 → admin:${organizationId} type=${payload.type}`);
  }

  /**
   * B5 Step 26: event.updated.v1
   * Emitted when event data changes (created, updated, guest joined, etc.).
   * Organization room so all admins receive it.
   */
  emitEventUpdated(organizationId: string, payload: EventUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'event.updated.v1', payload);
    this.logger.debug(`event.updated.v1 → admin:${organizationId} eventId=${payload.eventId}`);
  }

  /**
   * B5 Step 26: event.stats.updated.v1
   * Emitted when event guest count or attendance stats change.
   * Admin room only — guests don't need live stats.
   */
  emitEventStatsUpdated(organizationId: string, payload: EventStatsUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'event.stats.updated.v1', payload);
    this.logger.debug(`event.stats.updated.v1 → admin:${organizationId} eventId=${payload.eventId}`);
  }

  /**
   * B5 Step 26: attendance.analytics.updated.v1
   * Emitted when attendance analytics cache should be invalidated.
   * Admin room — students don't use analytics endpoints.
   */
  emitAttendanceAnalyticsUpdated(
    organizationId: string,
    groupId: string,
    payload: AttendanceAnalyticsUpdatedPayload,
  ): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'attendance.analytics.updated.v1', payload);
    this.logger.debug(`attendance.analytics.updated.v1 → admin:${organizationId} group:${groupId}`);
  }

  /**
   * GAP-WS-1: attendance.overridden.v1
   * Emitted when an admin overrides a member's attendance record.
   * Group room (live dashboards) + the affected user's room (their history view).
   * Additive: attendance.updated.v1 continues to fire for backward compatibility.
   */
  emitAttendanceOverridden(groupId: string, payload: AttendanceOverriddenPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'attendance.overridden.v1', payload);
    this.gateway!.emitToUser(payload.userId, 'attendance.overridden.v1', payload);
    this.logger.debug(`attendance.overridden.v1 → group:${groupId} user:${payload.userId}`);
  }

  /**
   * GAP-WS-1: guest.joined.v1
   * Emitted when a guest party joins an event (QR / join code).
   * Admin room — event admin dashboards update without manual refresh.
   * Additive: event.updated.v1 (action=guest_joined) continues to fire.
   */
  emitGuestJoined(organizationId: string, payload: GuestJoinedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'guest.joined.v1', payload);
    this.logger.debug(`guest.joined.v1 → admin:${organizationId} event:${payload.eventId}`);
  }

  /**
   * GAP-WS-1: guest.updated.v1
   * Emitted on guest party / person changes (rename, presence, meal selection, removal).
   * Admin room — keeps guest lists and meal analytics live.
   */
  emitGuestUpdated(organizationId: string, payload: GuestUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'guest.updated.v1', payload);
    this.logger.debug(`guest.updated.v1 → admin:${organizationId} event:${payload.eventId} action=${payload.action}`);
  }

  // ── Notice board (Phase B) ────────────────────────────────────────────────

  /**
   * notice.created.v1 — a new notice was posted. Group-scoped notices go to the
   * group room; org-wide notices (groupId null) go to the org room. Admin room
   * always receives it so admin bells update live. Additive + versioned.
   */
  emitNoticeCreated(
    organizationId: string,
    groupId: string | null,
    payload: NoticeCreatedPayload,
  ): void {
    if (!this.isReady) return;
    if (groupId) {
      this.gateway!.emitToGroup(groupId, 'notice.created.v1', payload);
    } else {
      this.gateway!.emitToOrg(organizationId, 'notice.created.v1', payload);
    }
    this.gateway!.emitToAdmin(organizationId, 'notice.created.v1', payload);
    this.logger.debug(`notice.created.v1 → org:${organizationId} group:${groupId ?? 'ALL'}`);
  }
}
