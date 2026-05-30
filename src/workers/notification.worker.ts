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
import { NotificationSendService } from '../features/notifications/services/notification-send.service';
import { NotificationPayloadService } from '../features/notifications/services/notification-payload.service';
import type {
  SendPushPayload,
  SendBatchPushPayload,
} from '../queue/interfaces/job-payload.interface';

@Processor(QUEUE_NAMES.NOTIFICATION, {
  concurrency: 5,
})
export class NotificationWorker extends WorkerHost {
  private readonly logger = new Logger(NotificationWorker.name);

  constructor(
    private readonly sendService: NotificationSendService,
    private readonly payloadBuilder: NotificationPayloadService,
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

    if (!result.success) {
      this.logger.warn(
        `Push send failed job=${job.id} user=${userId} ` +
        `errorCode=${result.errorCode} error=${result.error}`,
      );
      // Invalid token signals B7: enqueue token cleanup
      if (result.errorCode === 'messaging/registration-token-not-registered') {
        this.logger.warn(`Stale FCM token detected for user=${userId} — mark for cleanup`);
      }
      return; // Resolve cleanly — do not retry for delivery failures
    }

    this.logger.debug(`Push delivered job=${job.id} user=${userId} msgId=${result.messageId}`);
  }

  private async handleSendBatchPush(job: Job<SendBatchPushPayload>): Promise<void> {
    const { organizationId, recipients, title, body, route, data } = job.data;

    this.assertOrgId(organizationId, job.id);

    const { successful, failed } = await this.sendService.sendBatch(
      recipients,
      { title, body, route, data },
    );

    this.logger.log(
      `Batch push job=${job.id} ` +
      `successful=${successful.length} failed=${failed.length} ` +
      `total=${recipients.length}`,
    );
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
