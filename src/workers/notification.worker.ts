/**
 * notification.worker.ts — B6 Phase
 *
 * Processes jobs from notification-queue.
 *
 * Job types handled:
 *   send-push       — single FCM push (MVP: log-only)
 *   send-batch-push — batch FCM push to group members (MVP: log-only)
 *
 * Retry: exponential backoff 2s → 4s → 8s (3 attempts)
 * Dead-letter: failed jobs stay in queue.failed for 72h inspection
 *
 * Security:
 *   - organizationId validated before any operation
 *   - fcmToken masked in all logs (first 8 chars + last 4)
 *   - invalid token errors do NOT throw — logged and resolved cleanly
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';
import {
  NotificationSendService,
  STALE_TOKEN_ERROR_CODES,
} from '../features/notifications/services/notification-send.service';
import { NotificationPayloadService } from '../features/notifications/services/notification-payload.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type {
  SendPushPayload,
  SendBatchPushPayload,
} from '../queue/interfaces/job-payload.interface';

/** FR-NOTX-018: last-send diagnostics retention (7 days). */
const LAST_SEND_TTL_SECONDS = 7 * 24 * 60 * 60;

@Processor(QUEUE_NAMES.NOTIFICATION, {
  concurrency: 5,
})
export class NotificationWorker extends WorkerHost {
  private readonly logger = new Logger(NotificationWorker.name);

  constructor(
    private readonly sendService: NotificationSendService,
    private readonly payloadBuilder: NotificationPayloadService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing notification job=${job.id} type=${job.name}`);

    switch (job.name) {
      case JOB_TYPES.SEND_PUSH:
        await this.handleSendPush(job as Job<SendPushPayload>);
        break;

      case JOB_TYPES.SEND_BATCH_PUSH:
        await this.handleSendBatchPush(job as Job<SendBatchPushPayload>);
        break;

      default:
        this.logger.warn(`Unknown notification job type: ${job.name}`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleSendPush(job: Job<SendPushPayload>): Promise<void> {
    const { organizationId, userId, fcmToken, title, body, route, data } = job.data;

    // Security: org isolation check
    this.assertOrgId(organizationId, job.id);

    const result = await this.sendService.send(
      fcmToken,
      { title, body, route, data },
      userId,
    );

    await this.recordLastSend(organizationId, title, result.success ? 1 : 0, result.success ? 0 : 1, 1);

    if (!result.success) {
      this.logger.warn(
        `Push send failed job=${job.id} user=${userId} ` +
        `errorCode=${result.errorCode} error=${result.error}`,
      );
      // FR-NOTX-014 (ISSUE-16): the token is dead — prune it immediately so
      // this device stops failing silently and diagnostics reflect reality.
      if (result.errorCode && STALE_TOKEN_ERROR_CODES.has(result.errorCode)) {
        await this.pruneStaleTokens(organizationId, [{ userId, fcmToken }]);
      }
      return; // Resolve cleanly — do not retry for delivery failures
    }

    this.logger.debug(`Push delivered job=${job.id} user=${userId} msgId=${result.messageId}`);
  }

  private async handleSendBatchPush(job: Job<SendBatchPushPayload>): Promise<void> {
    const { organizationId, recipients, title, body, route, data } = job.data;

    this.assertOrgId(organizationId, job.id);

    const { successful, failed, staleTokens } = await this.sendService.sendBatch(
      recipients,
      { title, body, route, data },
    );

    // FR-NOTX-014: prune dead tokens found during the batch.
    if (staleTokens.length > 0) {
      await this.pruneStaleTokens(organizationId, staleTokens);
    }

    // FR-NOTX-018: record the outcome so admins can see the last-send result.
    await this.recordLastSend(
      organizationId,
      title,
      successful.length,
      failed.length,
      recipients.length,
    );

    this.logger.log(
      `Batch push job=${job.id} ` +
      `successful=${successful.length} failed=${failed.length} ` +
      `stale=${staleTokens.length} total=${recipients.length}`,
    );
  }

  // ── FR-NOTX-014: stale-token pruning ────────────────────────────────────────

  /**
   * Clears dead FCM tokens so future sends stop failing silently. Guarded by
   * BOTH userId and the exact failing token — a token the user re-registered
   * between send and prune is never wiped.
   */
  private async pruneStaleTokens(
    organizationId: string,
    stale: Array<{ userId: string; fcmToken: string }>,
  ): Promise<void> {
    try {
      for (const s of stale) {
        await this.prisma.user.updateMany({
          where: { id: s.userId, organizationId, fcmToken: s.fcmToken },
          data: { fcmToken: null },
        });
      }
      this.logger.log(
        `Pruned ${stale.length} stale FCM token(s) org=${organizationId}`,
      );
    } catch (err) {
      this.logger.warn(`Stale-token prune failed: ${(err as Error).message}`);
    }
  }

  // ── FR-NOTX-018: last-send diagnostics ──────────────────────────────────────

  /** Best-effort record of the most recent send outcome (7-day retention). */
  private async recordLastSend(
    organizationId: string,
    title: string,
    successful: number,
    failed: number,
    total: number,
  ): Promise<void> {
    try {
      await this.redis.set(
        `notify:lastsend:${organizationId}`,
        JSON.stringify({
          at: new Date().toISOString(),
          title,
          successful,
          failed,
          total,
        }),
        LAST_SEND_TTL_SECONDS,
      );
    } catch (_) {
      /* diagnostics stay best-effort */
    }
  }

  // ── Event handlers ───────────────────────────────────────────────────────────

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Notification job FAILED job=${job.id} type=${job.name} ` +
      `attempts=${job.attemptsMade}/${job.opts.attempts} ` +
      `error=${error.message}`,
      error.stack,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.debug(`Notification job completed job=${job.id} type=${job.name}`);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private assertOrgId(organizationId: string, jobId?: string): void {
    if (!organizationId) {
      throw new Error(
        `[NotificationWorker] Missing organizationId in job=${jobId}. Refusing to process.`,
      );
    }
  }
}
