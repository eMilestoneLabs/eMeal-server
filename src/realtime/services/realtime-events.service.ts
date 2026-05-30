import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { AttendanceGateway } from '../gateway/attendance.gateway';

/**
 * RealtimeEventsService — unified typed event emitter for all B7 realtime events.
 *
 * This service is the ONLY interface other feature modules should use to emit
 * WebSocket events. It isolates feature modules from the gateway implementation.
 *
 * Inject pattern (in feature modules):
 *   constructor(
 *     @Optional() @Inject('REALTIME_GATEWAY') private readonly realtime: RealtimeEventsService,
 *   ) {}
 *
 * All methods are no-ops if gateway is not connected (prevents DI errors in tests).
 *
 * ── Event naming convention (versioned, additive-safe) ─────────────────────
 *   attendance.marked.v1           — first-time attendance mark
 *   attendance.updated.v1          — admin override / re-mark
 *   meal.updated.v1                — meal config changed
 *   meal.published.v1              — meal activated for the day
 *   schedule.updated.v1            — schedule created or entries modified
 *   schedule.published.v1          — schedule published to students
 *   dashboard.summary.updated.v1   — admin/student dashboard cache bust
 *   member.blocked.v1              — member blocked by admin
 *   group.member.updated.v1        — member joined / removed / role changed
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

// ── Service ───────────────────────────────────────────────────────────────────

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

  /**
   * Emit when attendance is marked for the FIRST time.
   * Broadcast to group:{groupId} room.
   */
  emitAttendanceMarked(groupId: string, payload: AttendanceMarkedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'attendance.marked.v1', payload);
    this.logger.debug(`attendance.marked.v1 → group:${groupId} userId=${payload.userId}`);
  }

  /**
   * Emit when attendance is overridden (admin override / re-mark).
   * Broadcast to group:{groupId} room.
   */
  emitAttendanceUpdated(groupId: string, payload: AttendanceUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'attendance.updated.v1', payload);
    this.logger.debug(`attendance.updated.v1 → group:${groupId} userId=${payload.userId}`);
  }

  // ── Meal events ───────────────────────────────────────────────────────────

  /**
   * Emit when a meal's config changes (isActive, slotKey, schedule, etc.).
   * Broadcast to organization:{organizationId} room.
   */
  emitMealUpdated(organizationId: string, payload: MealUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToOrg(organizationId, 'meal.updated.v1', payload);
    this.logger.debug(`meal.updated.v1 → org:${organizationId} mealId=${payload.mealId}`);
  }

  /**
   * Emit when a meal is published/activated for the current day.
   * Broadcast to group:{groupId} room (students need to see it).
   */
  emitMealPublished(groupId: string, organizationId: string, payload: MealPublishedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'meal.published.v1', payload);
    this.logger.debug(`meal.published.v1 → group:${groupId} mealId=${payload.mealId}`);
  }

  // ── Schedule events ───────────────────────────────────────────────────────

  /**
   * Emit when a schedule is created or its entries are modified (still draft).
   * Broadcast to admin room only.
   */
  emitScheduleUpdated(organizationId: string, payload: ScheduleUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToAdmin(organizationId, 'schedule.updated.v1', payload);
    this.logger.debug(`schedule.updated.v1 → admin:${organizationId}`);
  }

  /**
   * Emit when a schedule is published (students can now see it).
   * Broadcast to group room so students receive it.
   */
  emitSchedulePublished(groupId: string, organizationId: string, payload: ScheduleUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'schedule.published.v1', payload);
    this.gateway!.emitToAdmin(organizationId, 'schedule.published.v1', payload);
    this.logger.debug(`schedule.published.v1 → group:${groupId} + admin:${organizationId}`);
  }

  // ── Dashboard events ──────────────────────────────────────────────────────

  /**
   * Emit when dashboard summary data changes (attendance marked, meal updated, etc.).
   * Triggers Flutter to invalidate its dashboard cache and re-fetch.
   * Broadcast to both group and admin rooms.
   */
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

  /**
   * Emit when a member is blocked by an admin.
   * Broadcasts to group room so all connected clients know.
   * The blocked user's socket will be disconnected by the gateway.
   */
  emitMemberBlocked(groupId: string, payload: MemberBlockedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'member.blocked.v1', payload);
    // Also emit directly to the blocked user's personal room
    this.gateway!.emitToUser(payload.userId, 'member.blocked.v1', payload);
    this.logger.debug(`member.blocked.v1 → group:${groupId} userId=${payload.userId}`);
  }

  /**
   * Emit when any group membership changes (joined, left, removed, role changed).
   * Broadcast to group:{groupId} room.
   */
  emitGroupMemberUpdated(groupId: string, payload: GroupMemberUpdatedPayload): void {
    if (!this.isReady) return;
    this.gateway!.emitToGroup(groupId, 'group.member.updated.v1', payload);
    this.logger.debug(`group.member.updated.v1 → group:${groupId} action=${payload.action}`);
  }
}
