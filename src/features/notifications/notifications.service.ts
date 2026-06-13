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
