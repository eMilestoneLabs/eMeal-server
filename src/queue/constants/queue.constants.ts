/**
 * queue.constants.ts — B6 Phase
 *
 * Canonical queue names and job type identifiers.
 * All workers and producers reference these constants — never raw strings.
 *
 * Queue architecture:
 *   notification-queue        — push notifications, FCM sends
 *   attendance-reminder-queue — scheduled attendance window reminders
 *   analytics-queue           — daily/weekly aggregation background jobs
 *   export-queue              — async large-data export generation
 *   cleanup-queue             — token purge, orphan records, expired events
 */

// ── Queue names ────────────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  NOTIFICATION: 'notification-queue',
  ATTENDANCE_REMINDER: 'attendance-reminder-queue',
  ANALYTICS: 'analytics-queue',
  EXPORT: 'export-queue',
  CLEANUP: 'cleanup-queue',
  SCHEDULE_PUBLISH: 'schedule-publish-queue',
  // Pass 7 (FR-TRUST-001): opt-out system-default materialization. Own queue
  // — a second processor on an existing queue would steal that queue's jobs.
  SYSTEM_DEFAULT: 'system-default-queue',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ── Job type identifiers ────────────────────────────────────────────────────────

export const JOB_TYPES = {
  // notification-queue
  SEND_PUSH: 'send-push',
  SEND_BATCH_PUSH: 'send-batch-push',

  // attendance-reminder-queue
  SCHEDULE_REMINDER: 'schedule-reminder',
  CANCEL_REMINDER: 'cancel-reminder',
  DISPATCH_REMINDER: 'dispatch-reminder',
  // Pass 7 (FR-TRUST-001): opt-out group system-default materialization
  SYSTEM_DEFAULT_SWEEP: 'system-default-sweep',
  // Pass 11 (FR-VACX-006): vacation flag lifecycle sweep — rides the
  // system-default queue (both are low-frequency lifecycle materializations;
  // the worker branches on job name, so no new queue infrastructure).
  VACATION_SWEEP: 'vacation-sweep',

  // analytics-queue
  AGGREGATE_DAILY: 'aggregate-daily',
  AGGREGATE_GROUP: 'aggregate-group',

  // export-queue
  GENERATE_EXPORT: 'generate-export',

  // cleanup-queue
  CLEANUP_STALE_TOKENS: 'cleanup-stale-tokens',
  CLEANUP_EXPIRED_EVENTS: 'cleanup-expired-events',
  CLEANUP_ORPHAN_RECORDS: 'cleanup-orphan-records',
  CLEANUP_AUDIT_LOGS: 'cleanup-audit-logs',
  PUBLISH_SCHEDULE: 'publish-schedule',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

// ── Retry configuration (exponential backoff) ──────────────────────────────────

export const RETRY_CONFIG = {
  /** Max attempts before job is moved to failed state */
  MAX_ATTEMPTS: 3,
  /** Initial backoff delay in milliseconds */
  INITIAL_DELAY_MS: 2000,
  /** Backoff type — exponential: 2s → 4s → 8s */
  BACKOFF_TYPE: 'exponential' as const,
  /** Keep failed jobs in Redis for 72 hours for inspection */
  FAILED_JOB_KEEP_MS: 72 * 60 * 60 * 1000,
  /** Keep completed jobs for 1 hour */
  COMPLETED_JOB_KEEP_MS: 60 * 60 * 1000,
} as const;

// ── Default job options ────────────────────────────────────────────────────────

export const DEFAULT_JOB_OPTIONS = {
  attempts: RETRY_CONFIG.MAX_ATTEMPTS,
  backoff: {
    type: RETRY_CONFIG.BACKOFF_TYPE,
    delay: RETRY_CONFIG.INITIAL_DELAY_MS,
  },
  removeOnComplete: {
    age: RETRY_CONFIG.COMPLETED_JOB_KEEP_MS / 1000,
    count: 500,
  },
  removeOnFail: {
    age: RETRY_CONFIG.FAILED_JOB_KEEP_MS / 1000,
    count: 200,
  },
} as const;

// ── Queue-specific concurrency settings ────────────────────────────────────────

export const QUEUE_CONCURRENCY = {
  NOTIFICATION: 5,         // up to 5 push sends in parallel
  ATTENDANCE_REMINDER: 3,  // reminder scheduling is lightweight
  ANALYTICS: 1,            // analytics runs sequentially to avoid DB lock contention
  EXPORT: 2,               // two concurrent exports max
  CLEANUP: 1,              // cleanup always sequential for safety
  SCHEDULE_PUBLISH: 2,     // two concurrent deferred publishes
} as const;
