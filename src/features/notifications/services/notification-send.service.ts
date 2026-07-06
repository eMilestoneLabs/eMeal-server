/**
 * notification-send.service.ts — FCM delivery.
 *
 * Phase 2 (B7): real Firebase Cloud Messaging send. Activates automatically when
 * FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are set;
 * otherwise it degrades to MVP log-only (so dev/unconfigured envs still work).
 *
 * firebase-admin is lazy-`require`d inside init so the project still builds before
 * the package is installed — it is only needed at runtime once FCM is configured.
 *   Setup: npm install firebase-admin  +  set the 3 FIREBASE_* env vars.
 *
 * Security / robustness:
 *   - fcmToken validated before send.
 *   - delivery failures are caught + returned (never thrown) — the queue job stays clean.
 *   - invalid-token errors return an errorCode the worker uses to enqueue token cleanup.
 *   - FCM `data` values are coerced to strings (FCM requirement).
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type { NotificationPayload } from './notification-payload.service';

export interface NotificationDeliveryResult {
  success: boolean;
  messageId?: string;
  errorCode?: string;
  error?: string;
}

/** FCM error codes that mean the token is dead and must be pruned (FR-NOTX-014). */
export const STALE_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

@Injectable()
export class NotificationSendService implements OnModuleInit {
  private readonly logger = new Logger(NotificationSendService.name);

  /** True once firebase-admin is initialized from env. */
  private fcmEnabled = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private messaging: any = null;

  constructor(private readonly config: ConfigService) {}

  /** FR-NOTX-018: whether the real FCM channel is configured (vs log-only). */
  get pushEnabled(): boolean {
    return this.fcmEnabled;
  }

  onModuleInit(): void {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    let privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.log('FCM disabled (FIREBASE_* not set) — notifications are log-only');
      return;
    }
    // env stores the key with literal "\n"; convert to real newlines
    privateKey = privateKey.replace(/\\n/g, '\n');

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        });
      }
      this.messaging = admin.messaging();
      this.fcmEnabled = true;
      this.logger.log(`FCM enabled (project=${projectId})`);
    } catch (err) {
      this.logger.error(
        `FCM init failed — falling back to log-only: ${(err as Error).message}`,
      );
      this.fcmEnabled = false;
    }
  }

  /**
   * Send a single notification to one FCM token.
   */
  async send(
    fcmToken: string,
    payload: NotificationPayload,
    userId: string,
  ): Promise<NotificationDeliveryResult> {
    if (!fcmToken) {
      return { success: false, errorCode: 'no_token', error: 'No FCM token registered' };
    }
    if (!this.fcmEnabled) {
      return this.logNotification(fcmToken, payload, userId);
    }
    return this.actualFcmSend(fcmToken, payload, userId);
  }

  /**
   * Send to multiple tokens (batch) with concurrency capping (chunks of 50) so a
   * large group can't fire thousands of simultaneous FCM requests.
   */
  async sendBatch(
    recipients: Array<{ userId: string; fcmToken: string }>,
    payload: NotificationPayload,
  ): Promise<{
    successful: string[];
    failed: string[];
    // FR-NOTX-014: dead tokens detected during the batch — the worker prunes
    // them so future sends stop failing silently for these devices.
    staleTokens: Array<{ userId: string; fcmToken: string }>;
  }> {
    const BATCH_CHUNK_SIZE = 50;
    const successful: string[] = [];
    const failed: string[] = [];
    const staleTokens: Array<{ userId: string; fcmToken: string }> = [];

    for (let i = 0; i < recipients.length; i += BATCH_CHUNK_SIZE) {
      const chunk = recipients.slice(i, i + BATCH_CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map((r) => this.send(r.fcmToken, payload, r.userId)),
      );
      results.forEach((result, j) => {
        if (result.status === 'fulfilled' && result.value.success) {
          successful.push(chunk[j].userId);
        } else {
          failed.push(chunk[j].userId);
          if (
            result.status === 'fulfilled' &&
            result.value.errorCode &&
            STALE_TOKEN_ERROR_CODES.has(result.value.errorCode)
          ) {
            staleTokens.push(chunk[j]);
          }
          this.logger.warn(`[NotificationSend] Batch send failed for user=${chunk[j].userId}`);
        }
      });
    }
    return { successful, failed, staleTokens };
  }

  // ── Real FCM send (Phase 2) ──────────────────────────────────────────────────

  private async actualFcmSend(
    fcmToken: string,
    payload: NotificationPayload,
    userId: string,
  ): Promise<NotificationDeliveryResult> {
    try {
      // PRIORITY-1 (duplicate-notification fix): a stable collapse identity for
      // this logical event. Android `tag`/`collapseKey` and iOS
      // `apns-collapse-id` make the OS REPLACE rather than stack, so the same
      // notification can never appear twice — whether from an OS-tray + in-app
      // double draw, a re-delivery, or an accidental double enqueue.
      const tag = this.collapseTag(payload);
      const dataWithTag = this.stringifyData({
        route: payload.route,
        // Forwarded so the client can render a single notification with a
        // matching id/tag (see push_notification_service.dart).
        dedupeId: tag,
        ...(payload.data ?? {}),
      });
      const message = {
        token: fcmToken,
        notification: { title: payload.title, body: payload.body },
        data: dataWithTag,
        android: {
          priority: 'high' as const,
          collapseKey: tag,
          notification: { tag },
        },
        apns: {
          headers: { 'apns-priority': '10', 'apns-collapse-id': tag },
        },
      };
      const messageId: string = await this.messaging.send(message);
      return { success: true, messageId };
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      const errorCode = e?.errorInfo?.code ?? e?.code ?? 'unknown';
      // Invalid/expired token → worker enqueues cleanup based on errorCode
      this.logger.warn(`[FCM] send failed user=${userId} code=${errorCode}`);
      return { success: false, errorCode, error: e?.message };
    }
  }

  /**
   * PRIORITY-1: a deterministic collapse tag for a notification. Prefers an
   * explicit `data.dedupeId`; else derives one from the event type + the entity
   * it concerns (noticeId / date / groupId / route) so two identical logical
   * events map to the SAME tag. Bounded to a short, tag-safe hex string.
   */
  private collapseTag(payload: NotificationPayload): string {
    const d = (payload.data ?? {}) as Record<string, unknown>;
    const explicit = d.dedupeId ?? d.tag;
    const base =
      (explicit as string) ||
      [
        d.type ?? 'notif',
        d.noticeId ?? d.date ?? d.groupId ?? payload.route ?? '',
      ].join(':');
    return createHash('sha1')
      .update(`${base}|${payload.title}`)
      .digest('hex')
      .slice(0, 24);
  }

  /** FCM `data` payload values MUST be strings. */
  private stringifyData(obj: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
    return out;
  }

  // ── MVP log-only path (used when FCM not configured) ─────────────────────────

  private logNotification(
    fcmToken: string,
    payload: NotificationPayload,
    userId: string,
  ): NotificationDeliveryResult {
    const maskedToken = `${fcmToken.slice(0, 8)}...${fcmToken.slice(-4)}`;
    this.logger.log(
      `[FCM:LOG] userId=${userId} token=${maskedToken} title="${payload.title}" route="${payload.route}"`,
    );
    return { success: true, messageId: `log-${Date.now()}` };
  }
}
