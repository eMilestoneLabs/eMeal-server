/**
 * queue.service.ts — B6 Phase
 *
 * Central job enqueueing service. All features MUST go through QueueService
 * to enqueue jobs — never inject Queue instances directly into feature services.
 *
 * Responsibilities:
 *   - Builds typed job payloads with dedupKey + enqueuedAt timestamps
 *   - Enforces organizationId presence before enqueueing
 *   - Provides typed enqueue methods per job type
 *   - Handles delayed job scheduling (reminders)
 *
 * Idempotency:
 *   dedupKey = `<jobType>:<organizationId>:<domain-specific-id>`
 *   Workers use this key in Redis setNx to prevent double-execution.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, JobsOptions } from 'bullmq';
import {
  QUEUE_NAMES,
  JOB_TYPES,
  DEFAULT_JOB_OPTIONS,
} from './constants/queue.constants';
import type {
  SendPushPayload,
  SendBatchPushPayload,
  ScheduleReminderPayload,
  CancelReminderPayload,
  DispatchReminderPayload,
  AggregateDailyPayload,
  AggregateGroupPayload,
  GenerateExportPayload,
  CleanupStaleTokensPayload,
  CleanupExpiredEventsPayload,
  CleanupOrphanRecordsPayload,
  CleanupAuditLogsPayload,
} from './interfaces/job-payload.interface';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.NOTIFICATION)
    private readonly notificationQueue: Queue,

    @InjectQueue(QUEUE_NAMES.ATTENDANCE_REMINDER)
    private readonly reminderQueue: Queue,

    @InjectQueue(QUEUE_NAMES.ANALYTICS)
    private readonly analyticsQueue: Queue,

    @InjectQueue(QUEUE_NAMES.EXPORT)
    private readonly exportQueue: Queue,

    @InjectQueue(QUEUE_NAMES.CLEANUP)
    private readonly cleanupQueue: Queue,

    @InjectQueue(QUEUE_NAMES.SCHEDULE_PUBLISH)
    private readonly schedulePublishQueue: Queue,

    @InjectQueue(QUEUE_NAMES.SYSTEM_DEFAULT)
    private readonly systemDefaultQueue: Queue,
  ) {}

  // ── NOTIFICATION JOBS ──────────────────────────────────────────────────────

  /**
   * Enqueue a single FCM push notification.
   * In MVP: job is enqueued but NotificationSendService logs instead of FCM-sending.
   * B7: swap in actual firebase-admin send.
   */
  async enqueuePush(
    payload: Omit<SendPushPayload, 'dedupKey' | 'enqueuedAt'>,
    opts?: JobsOptions,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.SEND_PUSH);

    const dedupKey = `${JOB_TYPES.SEND_PUSH}:${payload.organizationId}:${payload.userId}:${Date.now()}`;
    const job = await this.notificationQueue.add(
      JOB_TYPES.SEND_PUSH,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as SendPushPayload,
      { ...DEFAULT_JOB_OPTIONS, ...opts },
    );

    this.logger.debug(`Enqueued ${JOB_TYPES.SEND_PUSH} job=${job.id} user=${payload.userId}`);
    return job.id!;
  }

  /**
   * Enqueue a batch push notification to multiple users (e.g., group reminder).
   */
  async enqueueBatchPush(
    payload: Omit<SendBatchPushPayload, 'dedupKey' | 'enqueuedAt'>,
    opts?: JobsOptions,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.SEND_BATCH_PUSH);

    const dedupKey = `${JOB_TYPES.SEND_BATCH_PUSH}:${payload.organizationId}:${Date.now()}`;
    const job = await this.notificationQueue.add(
      JOB_TYPES.SEND_BATCH_PUSH,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as SendBatchPushPayload,
      { ...DEFAULT_JOB_OPTIONS, ...opts },
    );

    this.logger.debug(`Enqueued ${JOB_TYPES.SEND_BATCH_PUSH} job=${job.id} recipients=${payload.recipients.length}`);
    return job.id!;
  }

  // ── ATTENDANCE REMINDER JOBS ───────────────────────────────────────────────

  /**
   * Schedule an attendance window reminder.
   * @param delayMs - milliseconds until the reminder fires
   */
  async scheduleAttendanceReminder(
    payload: Omit<ScheduleReminderPayload, 'dedupKey' | 'enqueuedAt'>,
    delayMs: number,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.SCHEDULE_REMINDER);

    const dedupKey = `${JOB_TYPES.SCHEDULE_REMINDER}:${payload.organizationId}:${payload.mealId}:${payload.minutesBefore}min`;
    const job = await this.reminderQueue.add(
      JOB_TYPES.DISPATCH_REMINDER,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as ScheduleReminderPayload,
      { ...DEFAULT_JOB_OPTIONS, delay: delayMs, jobId: dedupKey },
    );

    this.logger.log(`Scheduled reminder job=${job.id} meal=${payload.mealId} delay=${delayMs}ms`);
    return job.id!;
  }

  /**
   * Cancel a previously scheduled reminder.
   */
  async cancelAttendanceReminder(
    payload: Omit<CancelReminderPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<void> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.CANCEL_REMINDER);

    const job = await this.reminderQueue.getJob(payload.reminderJobId);
    if (job) {
      await job.remove();
      this.logger.log(`Cancelled reminder job=${payload.reminderJobId} meal=${payload.mealId}`);
    }
  }

  // ── ANALYTICS JOBS ─────────────────────────────────────────────────────────

  async enqueueAggregateDaily(
    payload: Omit<AggregateDailyPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.AGGREGATE_DAILY);

    const dedupKey = `${JOB_TYPES.AGGREGATE_DAILY}:${payload.organizationId}:${payload.date}`;
    const job = await this.analyticsQueue.add(
      JOB_TYPES.AGGREGATE_DAILY,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as AggregateDailyPayload,
      { ...DEFAULT_JOB_OPTIONS, jobId: dedupKey }, // jobId = dedupKey prevents duplicate jobs
    );

    this.logger.debug(`Enqueued aggregate-daily job=${job.id} date=${payload.date}`);
    return job.id!;
  }

  async enqueueAggregateGroup(
    payload: Omit<AggregateGroupPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.AGGREGATE_GROUP);

    const dedupKey = `${JOB_TYPES.AGGREGATE_GROUP}:${payload.organizationId}:${payload.groupId}:${payload.fromDate}:${payload.toDate}`;
    const job = await this.analyticsQueue.add(
      JOB_TYPES.AGGREGATE_GROUP,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as AggregateGroupPayload,
      { ...DEFAULT_JOB_OPTIONS, jobId: dedupKey },
    );

    this.logger.debug(`Enqueued aggregate-group job=${job.id} group=${payload.groupId}`);
    return job.id!;
  }

  // ── EXPORT JOBS ────────────────────────────────────────────────────────────

  async enqueueExport(
    payload: Omit<GenerateExportPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.GENERATE_EXPORT);

    const dedupKey = `${JOB_TYPES.GENERATE_EXPORT}:${payload.organizationId}:${payload.exportType}:${Date.now()}`;
    const job = await this.exportQueue.add(
      JOB_TYPES.GENERATE_EXPORT,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as GenerateExportPayload,
      DEFAULT_JOB_OPTIONS,
    );

    this.logger.log(`Enqueued export job=${job.id} type=${payload.exportType} format=${payload.format}`);
    return job.id!;
  }

  // ── CLEANUP JOBS ───────────────────────────────────────────────────────────

  async enqueueStaleTokenCleanup(
    payload: Omit<CleanupStaleTokensPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.CLEANUP_STALE_TOKENS);

    const dedupKey = `${JOB_TYPES.CLEANUP_STALE_TOKENS}:${payload.organizationId}:${new Date().toISOString().slice(0, 10)}`;
    const job = await this.cleanupQueue.add(
      JOB_TYPES.CLEANUP_STALE_TOKENS,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as CleanupStaleTokensPayload,
      { ...DEFAULT_JOB_OPTIONS, jobId: dedupKey },
    );

    this.logger.debug(`Enqueued stale-token-cleanup job=${job.id}`);
    return job.id!;
  }

  async enqueueExpiredEventCleanup(
    payload: Omit<CleanupExpiredEventsPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.CLEANUP_EXPIRED_EVENTS);

    const dedupKey = `${JOB_TYPES.CLEANUP_EXPIRED_EVENTS}:${payload.organizationId}:${payload.cutoffDate}`;
    const job = await this.cleanupQueue.add(
      JOB_TYPES.CLEANUP_EXPIRED_EVENTS,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as CleanupExpiredEventsPayload,
      { ...DEFAULT_JOB_OPTIONS, jobId: dedupKey },
    );

    this.logger.debug(`Enqueued expired-event-cleanup job=${job.id}`);
    return job.id!;
  }

  async enqueueOrphanCleanup(
    payload: Omit<CleanupOrphanRecordsPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.CLEANUP_ORPHAN_RECORDS);

    const dedupKey = `${JOB_TYPES.CLEANUP_ORPHAN_RECORDS}:${payload.organizationId}:${payload.entityType}:${new Date().toISOString().slice(0, 10)}`;
    const job = await this.cleanupQueue.add(
      JOB_TYPES.CLEANUP_ORPHAN_RECORDS,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as CleanupOrphanRecordsPayload,
      { ...DEFAULT_JOB_OPTIONS, jobId: dedupKey },
    );

    return job.id!;
  }

  async enqueueAuditLogCleanup(
    payload: Omit<CleanupAuditLogsPayload, 'dedupKey' | 'enqueuedAt'>,
  ): Promise<string> {
    this.assertOrgId(payload.organizationId, JOB_TYPES.CLEANUP_AUDIT_LOGS);

    const dedupKey = `${JOB_TYPES.CLEANUP_AUDIT_LOGS}:${payload.organizationId}:${new Date().toISOString().slice(0, 10)}`;
    const job = await this.cleanupQueue.add(
      JOB_TYPES.CLEANUP_AUDIT_LOGS,
      { ...payload, dedupKey, enqueuedAt: new Date().toISOString() } as CleanupAuditLogsPayload,
      { ...DEFAULT_JOB_OPTIONS, jobId: dedupKey },
    );

    return job.id!;
  }

  // ── QUEUE METRICS ──────────────────────────────────────────────────────────

  /**
   * Returns counts for all queues — used by health endpoint and Bull Board.
   */
  async getQueueMetrics(): Promise<Record<string, Record<string, number>>> {
    const queues = [
      { name: QUEUE_NAMES.NOTIFICATION, queue: this.notificationQueue },
      { name: QUEUE_NAMES.ATTENDANCE_REMINDER, queue: this.reminderQueue },
      { name: QUEUE_NAMES.ANALYTICS, queue: this.analyticsQueue },
      { name: QUEUE_NAMES.EXPORT, queue: this.exportQueue },
      { name: QUEUE_NAMES.CLEANUP, queue: this.cleanupQueue },
      // Observability gap closed (Pass 7 validation finding): these two ran
      // fine but were invisible to /health and /admin/queues/stats.
      { name: QUEUE_NAMES.SCHEDULE_PUBLISH, queue: this.schedulePublishQueue },
      { name: QUEUE_NAMES.SYSTEM_DEFAULT, queue: this.systemDefaultQueue },
    ];

    const metrics: Record<string, Record<string, number>> = {};

    for (const { name, queue } of queues) {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
      ]);

      metrics[name] = { waiting, active, completed, failed, delayed };
    }

    return metrics;
  }

  // ── PRIVATE HELPERS ────────────────────────────────────────────────────────

  private assertOrgId(organizationId: string, jobType: string): void {
    if (!organizationId) {
      throw new Error(
        `[QueueService] organizationId is required for job type: ${jobType}. Refusing to enqueue without org scope.`,
      );
    }
  }
}
