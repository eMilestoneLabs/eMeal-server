/**
 * notification-payload.service.ts — B6 Phase
 *
 * Builds typed FCM notification payloads from business events.
 *
 * Flutter notification contract:
 * {
 *   notification: { title: string, body: string },
 *   data: { route: string, [key: string]: string }
 * }
 *
 * Route field is REQUIRED — Flutter reads it for Navigator.pushNamed().
 * All future FCM notifications must include a route.
 *
 * Current state: Flutter uses LOCAL notifications only.
 * B7: These payloads will be sent via firebase-admin.
 * The payload shape is identical — only the transport layer changes.
 */

import { Injectable } from '@nestjs/common';

export interface NotificationPayload {
  title: string;
  body: string;
  route: string;
  data?: Record<string, string>;
}

@Injectable()
export class NotificationPayloadService {
  // ── Attendance reminders ────────────────────────────────────────────────────

  /**
   * Reminder: attendance window closes in N minutes.
   * Route: /student/attendance
   *
   * Pass 15 (FR-NOTX-013): defaultPresent=true means the group runs opt-out
   * attendance — unmarked members are auto-marked Present at close
   * (FR-TRUST-001) — so the copy asks members to mark only if absent.
   */
  buildAttendanceReminderPayload(params: {
    mealSlotKey: string;
    minutesRemaining: number;
    defaultPresent?: boolean;
  }): NotificationPayload {
    const slot = this.formatSlot(params.mealSlotKey);
    return {
      title: 'Attendance Reminder',
      body: params.defaultPresent
        ? `${slot} attendance closes in ${params.minutesRemaining} minutes. You'll be marked present — update only if you're skipping.`
        : `${slot} attendance closes in ${params.minutesRemaining} minutes. Mark now!`,
      route: '/student/attendance',
      data: {
        type: 'attendance_reminder',
        mealSlot: params.mealSlotKey,
        minutesRemaining: String(params.minutesRemaining),
        // Live-Test-16 ISSUE-2: PER-MEAL collapse identity.
        // `NotificationSendService.collapseTag` prefers an explicit
        // `dedupeId ?? tag`, else falls back to
        // `type : (noticeId ?? date ?? groupId ?? route)` + the title. This
        // payload carries none of those and its title is a CONSTANT, so every
        // meal produced the SAME collapse key — Android `collapseKey`/`tag` and
        // iOS `apns-collapse-id` then REPLACE instead of stacking.
        //
        // That was harmless only while the withdrawn 1-hour minimum gap kept
        // reminders far apart. Now that CONCURRENT windows are allowed, several
        // meals remind at the same instant and a member would see just ONE of
        // them. Feeding the slot key into the collapse INPUT keeps the tag
        // per-meal; the forwarded `dedupeId` stays the hash, so client and OS
        // identities are unchanged in kind and a re-delivery of the SAME meal
        // still collapses exactly as before.
        tag: `attendance_reminder:${params.mealSlotKey}`,
      },
    };
  }

  /**
   * Confirmation: attendance successfully marked.
   * Route: /student/attendance
   */
  buildAttendanceConfirmPayload(params: {
    mealSlotKey: string;
    status: 'present' | 'absent' | 'skipped';
  }): NotificationPayload {
    const slot = this.formatSlot(params.mealSlotKey);
    const statusText: Record<string, string> = {
      present: 'marked as present',
      absent: 'marked as absent',
      skipped: 'skipped',
    };
    return {
      title: 'Attendance Updated',
      body: `Your ${slot} attendance has been ${statusText[params.status] ?? 'updated'}.`,
      route: '/student/attendance',
      data: { type: 'attendance_confirm', mealSlot: params.mealSlotKey, status: params.status },
    };
  }

  // ── Meal / schedule notifications ───────────────────────────────────────────

  /**
   * Schedule published: weekly menu is now available.
   * Route: /student/weekly-menu
   */
  buildSchedulePublishedPayload(params: {
    weekStartDate: string;
  }): NotificationPayload {
    return {
      title: 'Weekly Menu Available',
      body: `Your meal schedule for the week of ${params.weekStartDate} has been published.`,
      route: '/student/weekly-menu',
      data: { type: 'schedule_published', weekStart: params.weekStartDate },
    };
  }

  // ── Group / membership notifications ────────────────────────────────────────

  /**
   * User was added to or removed from a group.
   * Route: /student/dashboard
   */
  buildGroupMembershipPayload(params: {
    groupName: string;
    action: 'joined' | 'removed' | 'blocked';
  }): NotificationPayload {
    const messages: Record<string, string> = {
      joined: `You have been added to ${params.groupName}.`,
      removed: `You have been removed from ${params.groupName}.`,
      blocked: `Your access to ${params.groupName} has been suspended.`,
    };
    return {
      title: 'Group Update',
      body: messages[params.action] ?? 'Your group membership has changed.',
      route: '/student/dashboard',
      data: { type: 'group_membership', groupName: params.groupName, action: params.action },
    };
  }

  // ── Notice notifications (FR-NOTX-006 / ISSUE-15/16) ────────────────────────

  /**
   * A new notice was published — the in-app notice is the reliable channel;
   * this push is the best-effort alert. No sensitive data (FR-NOTX-017).
   * Route: /notices
   */
  buildNoticePublishedPayload(params: {
    title: string;
    priority: string;
    noticeId: string;
  }): NotificationPayload {
    const urgent = params.priority === 'urgent' || params.priority === 'high';
    return {
      title: urgent ? '📢 Important Notice' : 'New Notice',
      body: params.title,
      // The notice feed opens from the dashboard bell — there is no '/notices'
      // route in the frontend router (Issue 6: it 404'd in-app).
      route: '/student/dashboard',
      data: {
        type: 'notice_published',
        noticeId: params.noticeId,
        priority: params.priority,
      },
    };
  }

  // ── Correction requests (Module 33 / FR-ACR notifications) ──────────────────

  /**
   * A member raised an attendance correction request — sent to group admins.
   * Route: /admin/attendance (corrections queue lives there).
   */
  buildCorrectionRequestedPayload(params: {
    requesterName: string;
    typeLabel: string;
    mealName: string;
    dateStr: string;
  }): NotificationPayload {
    return {
      title: 'Correction Request',
      body:
        `${params.requesterName} requests "${params.typeLabel}" for ` +
        `${params.mealName} (${params.dateStr}).`,
      // Live-Test-11 ISSUE-001: land INSIDE the Correction Requests queue.
      // Older APKs resolve unknown routes to the dashboard (never 404).
      route: '/admin/attendance?open=corrections',
      data: { type: 'correction_requested' },
    };
  }

  /**
   * A correction request was decided — sent to the requesting member.
   * Route: /student/attendance (My Corrections lives there).
   */
  buildCorrectionDecidedPayload(params: {
    approved: boolean;
    mealName: string;
    dateStr: string;
  }): NotificationPayload {
    return {
      title: params.approved
        ? 'Correction Approved'
        : 'Correction Request Update',
      body: params.approved
        ? `Your correction for ${params.mealName} (${params.dateStr}) was approved.`
        : `Your correction for ${params.mealName} (${params.dateStr}) was not approved.`,
      route: '/student/attendance',
      data: { type: 'correction_decided', approved: String(params.approved) },
    };
  }

  /**
   * Live-Test-14 ISSUE-005: the admin's decision on a hosted-guest request.
   * Mirrors [buildCorrectionDecidedPayload] — FR-NOTX-017 safe (no amounts, no
   * other members' data) and routed to the REGISTERED member attendance path
   * where the guest sheet lives.
   */
  buildGuestDecidedPayload(params: {
    approved: boolean;
    mealName: string;
    dateStr: string;
  }): NotificationPayload {
    return {
      title: params.approved ? 'Guest Request Approved' : 'Guest Request Update',
      body: params.approved
        ? `Your guest booking for ${params.mealName} (${params.dateStr}) was approved.`
        : `Your guest booking for ${params.mealName} (${params.dateStr}) was not approved.`,
      route: '/student/attendance',
      data: { type: 'guest_decided', approved: String(params.approved) },
    };
  }

  // ── Event notifications ─────────────────────────────────────────────────────

  /**
   * Event guest joined successfully.
   * Route: /event/dashboard
   */
  buildEventJoinedPayload(params: {
    eventName: string;
  }): NotificationPayload {
    return {
      title: 'Event Joined',
      body: `You have joined "${params.eventName}". Select your meal preferences in the app.`,
      route: '/event/dashboard',
      data: { type: 'event_joined', eventName: params.eventName },
    };
  }

  // ── Admin notifications ─────────────────────────────────────────────────────

  /**
   * Admin alert: low attendance rate for a group.
   * Route: /admin/attendance
   */
  buildLowAttendanceAlertPayload(params: {
    groupName: string;
    attendanceRate: number;
  }): NotificationPayload {
    return {
      title: 'Low Attendance Alert',
      body: `${params.groupName} attendance is at ${params.attendanceRate}% today. Check the dashboard.`,
      route: '/admin/attendance',
      data: {
        type: 'low_attendance_alert',
        groupName: params.groupName,
        rate: String(params.attendanceRate),
      },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private formatSlot(slotKey: string): string {
    // Capitalize first letter: "breakfast" → "Breakfast"
    return slotKey.charAt(0).toUpperCase() + slotKey.slice(1).toLowerCase();
  }
}
