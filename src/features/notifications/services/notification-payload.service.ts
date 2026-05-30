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
   */
  buildAttendanceReminderPayload(params: {
    mealSlotKey: string;
    minutesRemaining: number;
  }): NotificationPayload {
    const slot = this.formatSlot(params.mealSlotKey);
    return {
      title: 'Attendance Reminder',
      body: `${slot} attendance closes in ${params.minutesRemaining} minutes. Mark now!`,
      route: '/student/attendance',
      data: {
        type: 'attendance_reminder',
        mealSlot: params.mealSlotKey,
        minutesRemaining: String(params.minutesRemaining),
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
