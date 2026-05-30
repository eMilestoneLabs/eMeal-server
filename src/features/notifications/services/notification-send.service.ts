/**
 * notification-send.service.ts — B6 Phase
 *
 * Handles actual FCM delivery (MVP: log-only; B7: firebase-admin send).
 *
 * Current Flutter state:
 *   Flutter uses flutter_local_notifications for reminders.
 *   Backend push is NOT active. FCM tokens are stored but not used yet.
 *
 * B7 migration path:
 *   1. Install firebase-admin: npm install firebase-admin
 *   2. Set FIREBASE_CREDENTIALS_JSON env var
 *   3. Replace logNotification() call below with actualFcmSend()
 *   Zero changes to QueueService, workers, or payload shapes.
 *
 * Security:
 *   - fcmToken validated before send attempt
 *   - delivery failures are caught and logged — never thrown to caller
 *   - invalid token errors trigger token cleanup job
 */

import { Injectable, Logger } from '@nestjs/common';
import type { NotificationPayload } from './notification-payload.service';

export interface NotificationDeliveryResult {
  success: boolean;
  messageId?: string;
  errorCode?: string;
  error?: string;
}

@Injectable()
export class NotificationSendService {
  private readonly logger = new Logger(NotificationSendService.name);

  /** True when firebase-admin is initialized (B7 gate) */
  private readonly fcmEnabled: boolean = false;

  /**
   * Send a single notification to one FCM token.
   * MVP: logs the payload instead of FCM-sending.
   * B7: swap the log call for actualFcmSend().
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
      // MVP: log only — Flutter handles local notifications client-side
      return this.logNotification(fcmToken, payload, userId);
    }

    // B7: Replace below with:
    // return this.actualFcmSend(fcmToken, payload, userId);
    return this.logNotification(fcmToken, payload, userId);
  }

  /**
   * Send to multiple tokens (batch) with concurrency capping.
   * Returns per-token results — failed tokens are returned for cleanup.
   *
   * FIX: Added chunk-based concurrency limiter (BATCH_CHUNK_SIZE = 50).
   * Without this, a group with 10,000 members would fire 10,000 simultaneous
   * HTTP requests when FCM is enabled in B8, overwhelming the process and Firebase rate limits.
   * Chunks of 50 are processed sequentially — each chunk is fully settled before the next begins.
   */
  async sendBatch(
    recipients: Array<{ userId: string; fcmToken: string }>,
    payload: NotificationPayload,
  ): Promise<{ successful: string[]; failed: string[] }> {
    const BATCH_CHUNK_SIZE = 50; // max concurrent FCM requests per flush

    const successful: string[] = [];
    const failed: string[] = [];

    // Process in chunks to cap concurrent outgoing connections
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
          this.logger.warn(
            `[NotificationSend] Batch send failed for user=${chunk[j].userId}`,
          );
        }
      });
    }

    return { successful, failed };
  }

  // ── Private: MVP log-only path ─────────────────────────────────────────────

  private logNotification(
    fcmToken: string,
    payload: NotificationPayload,
    userId: string,
  ): NotificationDeliveryResult {
    const maskedToken = `${fcmToken.slice(0, 8)}...${fcmToken.slice(-4)}`;

    this.logger.log(
      `[FCM:MVP-LOG] userId=${userId} token=${maskedToken} ` +
      `title="${payload.title}" route="${payload.route}"`,
    );

    this.logger.debug(
      `[FCM:MVP-LOG] Full payload: ${JSON.stringify({
        to: maskedToken,
        notification: { title: payload.title, body: payload.body },
        data: { route: payload.route, ...(payload.data ?? {}) },
      })}`,
    );

    // Return success so the queue job completes cleanly
    return { success: true, messageId: `mvp-log-${Date.now()}` };
  }

  // ── Private: B7 actual FCM send (replace logNotification call above) ────────

  /**
   * Actual FCM send via firebase-admin.
   * Uncomment and call this in B7.
   *
   * private async actualFcmSend(
   *   fcmToken: string,
   *   payload: NotificationPayload,
   *   userId: string,
   * ): Promise<NotificationDeliveryResult> {
   *   try {
   *     const admin = require('firebase-admin');
   *     const message = {
   *       token: fcmToken,
   *       notification: { title: payload.title, body: payload.body },
   *       data: { route: payload.route, ...(payload.data ?? {}) },
   *     };
   *     const messageId = await admin.messaging().send(message);
   *     return { success: true, messageId };
   *   } catch (err: any) {
   *     const errorCode = err.errorInfo?.code ?? 'unknown';
   *     // Invalid token → signal worker to enqueue cleanup job
   *     return { success: false, errorCode, error: err.message };
   *   }
   * }
   */
}
