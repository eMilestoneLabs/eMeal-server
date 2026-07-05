/**
 * notifications.service.ts — B6 Phase
 *
 * Orchestrates notification lifecycle:
 *   - FCM token registration with deduplication
 *   - Attendance reminder scheduling
 *   - Schedule publish notifications (batch)
 *   - Group membership change notifications
 *   - Event join notifications
 *
 * Current Flutter state:
 *   Flutter handles reminders locally via flutter_local_notifications.
 *   Backend enqueueing is infrastructure-ready for B7 FCM activation.
 *
 * Rules:
 *   - Never enqueue push if user has remindersEnabled=false
 *   - Never enqueue push if user is on vacationMode
 *   - FCM token deduplication: skip if token unchanged
 *   - All reminder enqueues go through QueueService (never direct Queue injection)
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { QueueService } from '../../queue/queue.service';
import {
  NotificationPayloadService,
} from './services/notification-payload.service';
import { NotificationSendService } from './services/notification-send.service';

// FCM token deduplication TTL in Redis — 24 hours
const TOKEN_DEDUP_TTL = 24 * 60 * 60;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: QueueService,
    private readonly payloadBuilder: NotificationPayloadService,
    private readonly sendService: NotificationSendService,
  ) {}

  // ── FCM TOKEN REGISTRATION ─────────────────────────────────────────────────

  /**
   * Register or update a user's FCM token.
   *
   * Deduplication: if the token is unchanged since last registration (checked
   * via Redis), skip the DB write to avoid unnecessary updates.
   * Redis key: `fcm:token:{userId}` — stores hash of last registered token.
   */
  async registerFcmToken(
    userId: string,
    token: string,
    metadata?: { platform?: string; appVersion?: string },
  ): Promise<{ registered: boolean; message: string }> {
    const dedupKey = `fcm:token:${userId}`;
    const storedToken = await this.redis.get(dedupKey);

    if (storedToken === token) {
      this.logger.debug(`FCM token unchanged for user=${userId} — skipping update`);
      return { registered: false, message: 'Token unchanged' };
    }

    // Persist to DB
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: token },
    });

    // Cache the new token for deduplication
    await this.redis.set(dedupKey, token, TOKEN_DEDUP_TTL);

    this.logger.log(
      `FCM token registered user=${userId} platform=${metadata?.platform ?? 'unknown'}`,
    );

    return { registered: true, message: 'FCM token registered successfully' };
  }

  /**
   * Revoke FCM token on logout — clears DB and Redis.
   * Prevents stale notifications after logout.
   */
  async revokeFcmToken(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: null },
    });
    await this.redis.del(`fcm:token:${userId}`);
    this.logger.log(`FCM token revoked for user=${userId}`);
  }

  // ── ATTENDANCE REMINDER SCHEDULING ────────────────────────────────────────

  /**
   * Schedule attendance window reminders for a meal.
   * Enqueues: 60-minute reminder + 30-minute reminder (if window allows).
   *
   * Rules enforced here (not in worker):
   *   - Only users with remindersEnabled=true receive reminders.
   *   - Users on vacation mode are excluded at delivery time (worker checks).
   *   - Window must be far enough in future for reminder to fire.
   */
  async scheduleAttendanceReminders(params: {
    organizationId: string;
    groupId: string;
    mealId: string;
    mealSlotKey: string;
    windowCloseAt: Date;
  }): Promise<void> {
    const now = Date.now();
    const closeMs = params.windowCloseAt.getTime();
    const minutesUntilClose = (closeMs - now) / (1000 * 60);

    // GAP-NOT-1 (RESOLVED): source-of-truth reminder offsets are 30 and 10 minutes
    // before the attendance window closes (FLUTTER_UI_SCREENSHOT student Settings:
    // "Reminded 30 min and 10 min before attendance windows close" + Student.md).
    // 30-minute reminder — only if window closes more than 35 minutes from now
    if (minutesUntilClose > 35) {
      const delay = closeMs - now - 30 * 60 * 1000;
      await this.queue.scheduleAttendanceReminder(
        {
          organizationId: params.organizationId,
          groupId: params.groupId,
          mealId: params.mealId,
          mealSlotKey: params.mealSlotKey,
          windowCloseAt: params.windowCloseAt.toISOString(),
          minutesBefore: 30,
        },
        delay,
      );
      this.logger.log(`Scheduled 30min reminder for meal=${params.mealId}`);
    }

    // 10-minute closing reminder — only if window closes more than 15 minutes from now
    if (minutesUntilClose > 15) {
      const delay = closeMs - now - 10 * 60 * 1000;
      await this.queue.scheduleAttendanceReminder(
        {
          organizationId: params.organizationId,
          groupId: params.groupId,
          mealId: params.mealId,
          mealSlotKey: params.mealSlotKey,
          windowCloseAt: params.windowCloseAt.toISOString(),
          minutesBefore: 10,
        },
        delay,
      );
      this.logger.log(`Scheduled 10min reminder for meal=${params.mealId}`);
    }
  }

  // ── SCHEDULE PUBLISH NOTIFICATION ─────────────────────────────────────────

  /**
   * Notify all active group members that a new weekly schedule has been published.
   * Uses batch push — one job per group covering all members.
   */
  async notifySchedulePublished(params: {
    organizationId: string;
    groupId: string;
    weekStartDate: string;
  }): Promise<void> {
    // Fetch active members with FCM tokens
    const members = await this.prisma.groupMember.findMany({
      where: {
        groupId: params.groupId,
        status: 'active',
        user: {
          isVacationMode: false,
          remindersEnabled: true,
          fcmToken: { not: null },
        },
      },
      select: {
        userId: true,
        user: { select: { fcmToken: true } },
      },
    });

    if (!members.length) {
      this.logger.debug(`No eligible members for schedule-published notification group=${params.groupId}`);
      return;
    }

    const recipients = members
      .filter((m) => m.user.fcmToken)
      .map((m) => ({ userId: m.userId, fcmToken: m.user.fcmToken! }));

    if (!recipients.length) return;

    const payload = this.payloadBuilder.buildSchedulePublishedPayload({
      weekStartDate: params.weekStartDate,
    });

    await this.queue.enqueueBatchPush({
      organizationId: params.organizationId,
      recipients,
      title: payload.title,
      body: payload.body,
      route: payload.route,
      data: payload.data,
    });

    this.logger.log(
      `Enqueued schedule-published batch push group=${params.groupId} recipients=${recipients.length}`,
    );
  }

  // ── NOTICE PUBLISHED (FR-NOTX-006 / ISSUE-15/16) ──────────────────────────

  /**
   * Push a "new notice" alert to every in-scope member. The stored notice is
   * the RELIABLE in-app channel (it exists regardless of this push); this is
   * the best-effort alert layer. Never throws — a push failure must never
   * break notice publishing (FR-NOTX-016).
   *
   * Vacation members still receive notices (they are announcements, not meal
   * reminders); the member's remindersEnabled consent flag is respected.
   */
  async notifyNoticePublished(params: {
    organizationId: string;
    groupId: string | null; // null = org-wide notice
    noticeId: string;
    title: string;
    priority: string;
  }): Promise<void> {
    try {
      let recipients: Array<{ userId: string; fcmToken: string }>;
      if (params.groupId) {
        const members = await this.prisma.groupMember.findMany({
          where: {
            groupId: params.groupId,
            status: 'active',
            user: { remindersEnabled: true, fcmToken: { not: null } },
          },
          select: { userId: true, user: { select: { fcmToken: true } } },
        });
        recipients = members
          .filter((m) => m.user.fcmToken)
          .map((m) => ({ userId: m.userId, fcmToken: m.user.fcmToken! }));
      } else {
        const users = await this.prisma.user.findMany({
          where: {
            organizationId: params.organizationId,
            remindersEnabled: true,
            fcmToken: { not: null },
          },
          select: { id: true, fcmToken: true },
        });
        recipients = users.map((u) => ({ userId: u.id, fcmToken: u.fcmToken! }));
      }

      if (!recipients.length) {
        this.logger.debug(
          `No push-eligible recipients for notice=${params.noticeId} — in-app notice remains available`,
        );
        return;
      }

      const payload = this.payloadBuilder.buildNoticePublishedPayload({
        title: params.title,
        priority: params.priority,
        noticeId: params.noticeId,
      });

      await this.queue.enqueueBatchPush({
        organizationId: params.organizationId,
        recipients,
        title: payload.title,
        body: payload.body,
        route: payload.route,
        data: payload.data,
      });

      this.logger.log(
        `Enqueued notice-published batch push notice=${params.noticeId} recipients=${recipients.length}`,
      );
    } catch (err) {
      // FR-NOTX-016: push is best-effort — the in-app notice already exists.
      this.logger.warn(
        `notice-published push enqueue failed (in-app notice unaffected): ${(err as Error).message}`,
      );
    }
  }

  // ── CORRECTION REQUESTS (Module 33 — FR-ACR notifications) ────────────────

  /** Alert group admins that a member raised a correction request. */
  async notifyCorrectionRequested(params: {
    organizationId: string;
    requesterName: string;
    typeLabel: string;
    mealName: string;
    dateStr: string;
  }): Promise<void> {
    try {
      const admins = await this.prisma.user.findMany({
        where: {
          organizationId: params.organizationId,
          role: {
            in: ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'],
          },
          fcmToken: { not: null },
        },
        select: { id: true, fcmToken: true },
      });
      if (!admins.length) return;

      const payload = this.payloadBuilder.buildCorrectionRequestedPayload({
        requesterName: params.requesterName,
        typeLabel: params.typeLabel,
        mealName: params.mealName,
        dateStr: params.dateStr,
      });

      await this.queue.enqueueBatchPush({
        organizationId: params.organizationId,
        recipients: admins.map((a) => ({ userId: a.id, fcmToken: a.fcmToken! })),
        title: payload.title,
        body: payload.body,
        route: payload.route,
        data: payload.data,
      });
    } catch (err) {
      this.logger.warn(
        `correction-requested push enqueue failed: ${(err as Error).message}`,
      );
    }
  }

  /** Alert the requesting member that their correction was decided. */
  async notifyCorrectionDecided(params: {
    organizationId: string;
    userId: string;
    approved: boolean;
    mealName: string;
    dateStr: string;
  }): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: params.userId },
        select: { fcmToken: true },
      });
      if (!user?.fcmToken) return;

      const payload = this.payloadBuilder.buildCorrectionDecidedPayload({
        approved: params.approved,
        mealName: params.mealName,
        dateStr: params.dateStr,
      });

      await this.queue.enqueuePush({
        organizationId: params.organizationId,
        userId: params.userId,
        fcmToken: user.fcmToken,
        title: payload.title,
        body: payload.body,
        route: payload.route,
        data: payload.data,
      });
    } catch (err) {
      this.logger.warn(
        `correction-decided push enqueue failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * SRS FR-TRUST-011 (Pass 7): any change to a member's attendance/billing by
   * anyone other than the member notifies them immediately with the delta and
   * reason. Fire-and-forget — never blocks or fails the write.
   */
  async notifyAttendanceChanged(params: {
    organizationId: string;
    userId: string;
    newStatus: string;
    dateStr: string;
    reason?: string | null;
    changedBy: 'admin' | 'system';
  }): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: params.userId },
        select: { fcmToken: true },
      });
      if (!user?.fcmToken) return;

      const who =
        params.changedBy === 'admin' ? 'an administrator' : 'group policy';
      await this.queue.enqueuePush({
        organizationId: params.organizationId,
        userId: params.userId,
        fcmToken: user.fcmToken,
        title: 'Your attendance was updated',
        body:
          `Your ${params.dateStr} attendance was set to ${params.newStatus} by ${who}` +
          (params.reason ? ` — ${params.reason}` : '') +
          '. Tap to review or request a correction.',
        // Registered frontend path (Issue 6: roleless routes 404'd in-app).
        route: '/student/attendance',
        data: {
          type: 'attendance_changed',
          date: params.dateStr,
          status: params.newStatus,
          changedBy: params.changedBy,
        },
      });
    } catch (err) {
      this.logger.warn(
        `attendance-changed push enqueue failed: ${(err as Error).message}`,
      );
    }
  }

  // ── DELIVERY DIAGNOSTICS (FR-NOTX-018 / ISSUE-16) ─────────────────────────

  /**
   * Makes "notifications are ON but nothing arrives" observable: whether the
   * push channel is configured, how many org members have a registered
   * device, and the outcome of the most recent send (recorded by the
   * notification worker in Redis).
   */
  async getDiagnostics(organizationId: string): Promise<Record<string, unknown>> {
    const [registeredDevices, totalMembers] = await Promise.all([
      this.prisma.user.count({
        where: { organizationId, fcmToken: { not: null } },
      }),
      this.prisma.user.count({ where: { organizationId } }),
    ]);

    let lastSend: unknown = null;
    try {
      const raw = await this.redis.get(`notify:lastsend:${organizationId}`);
      if (raw) lastSend = JSON.parse(raw);
    } catch (_) {
      /* diagnostics stay best-effort */
    }

    return {
      pushConfigured: this.sendService.pushEnabled,
      registeredDevices,
      membersWithoutDevice: totalMembers - registeredDevices,
      totalMembers,
      lastSend,
      // The in-app notice board is always available regardless of push.
      inAppChannel: 'always-on',
    };
  }

  // ── GROUP MEMBERSHIP NOTIFICATION ─────────────────────────────────────────

  /**
   * Notify a user about their group membership change (joined/removed/blocked).
   */
  async notifyGroupMembership(params: {
    organizationId: string;
    userId: string;
    groupName: string;
    action: 'joined' | 'removed' | 'blocked';
  }): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { fcmToken: true, remindersEnabled: true, isVacationMode: true },
    });

    if (!user?.fcmToken || !user.remindersEnabled || user.isVacationMode) {
      return;
    }

    const payload = this.payloadBuilder.buildGroupMembershipPayload({
      groupName: params.groupName,
      action: params.action,
    });

    await this.queue.enqueuePush({
      organizationId: params.organizationId,
      userId: params.userId,
      fcmToken: user.fcmToken,
      title: payload.title,
      body: payload.body,
      route: payload.route,
      data: payload.data,
    });
  }
}
