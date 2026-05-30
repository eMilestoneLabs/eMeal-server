/**
 * job-payload.interface.ts — B6 Phase
 *
 * Typed interfaces for every job payload.
 *
 * SECURITY RULE: Every payload includes organizationId — enforced at the worker
 * level before any DB operation. No cross-org contamination possible even if
 * a corrupted job somehow enters the queue.
 *
 * IDEMPOTENCY RULE: Every payload includes a dedupKey derived at enqueue time.
 * Workers check Redis dedupKey before processing to guard against duplicate
 * execution due to BullMQ retry + network partition edge cases.
 */

// ── Base payload ───────────────────────────────────────────────────────────────

export interface BaseJobPayload {
  /** Organization scope — validated in every worker before DB ops */
  organizationId: string;
  /** Deduplication key — worker checks Redis before processing */
  dedupKey: string;
  /** ISO timestamp when this job was enqueued */
  enqueuedAt: string;
  /** Requesting user / system actor for audit trail */
  actorId?: string;
}

// ── notification-queue ─────────────────────────────────────────────────────────

/**
 * FCM push notification payload.
 * Route field is REQUIRED for Flutter navigation (B6 contract).
 * Flutter reads: { notification: { title, body }, data: { route } }
 */
export interface SendPushPayload extends BaseJobPayload {
  userId: string;
  fcmToken: string;
  title: string;
  body: string;
  /**
   * Route for Flutter Navigator.
   * Future FCM payload: { "route": "/student/attendance" }
   */
  route: string;
  /** Additional key-value data for the notification */
  data?: Record<string, string>;
}

export interface SendBatchPushPayload extends BaseJobPayload {
  /** Array of userId→fcmToken pairs */
  recipients: Array<{ userId: string; fcmToken: string }>;
  title: string;
  body: string;
  route: string;
  data?: Record<string, string>;
}

// ── attendance-reminder-queue ──────────────────────────────────────────────────

export interface ScheduleReminderPayload extends BaseJobPayload {
  groupId: string;
  mealId: string;
  mealSlotKey: string;
  /** ISO timestamp when the attendance window closes */
  windowCloseAt: string;
  /** Minutes before close to fire reminder (e.g., 60 or 30) */
  minutesBefore: number;
}

export interface CancelReminderPayload extends BaseJobPayload {
  /** BullMQ job ID to remove from the queue */
  reminderJobId: string;
  groupId: string;
  mealId: string;
}

export interface DispatchReminderPayload extends BaseJobPayload {
  groupId: string;
  mealId: string;
  mealSlotKey: string;
  /** Reminder text sent to users */
  reminderType: '60min' | '30min';
}

// ── analytics-queue ────────────────────────────────────────────────────────────

export interface AggregateDailyPayload extends BaseJobPayload {
  /** Date to aggregate — YYYY-MM-DD */
  date: string;
}

export interface AggregateGroupPayload extends BaseJobPayload {
  groupId: string;
  /** Date range for aggregation */
  fromDate: string;
  toDate: string;
}

// ── export-queue ───────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'xlsx';
export type ExportType = 'attendance' | 'event-guests';

export interface GenerateExportPayload extends BaseJobPayload {
  exportType: ExportType;
  format: ExportFormat;
  /** For attendance exports */
  groupId?: string;
  /** For event guest exports */
  eventId?: string;
  fromDate?: string;
  toDate?: string;
  requestingUserId: string;
  /** Callback URL or storage key to write result — future feature */
  callbackKey?: string;
}

// ── cleanup-queue ──────────────────────────────────────────────────────────────

export interface CleanupStaleTokensPayload extends BaseJobPayload {
  /** Tokens older than this many days are purged */
  olderThanDays: number;
}

export interface CleanupExpiredEventsPayload extends BaseJobPayload {
  /** ISO cutoff — events with autoDeleteAt before this are soft-deleted */
  cutoffDate: string;
}

export interface CleanupOrphanRecordsPayload extends BaseJobPayload {
  /** Type of record to clean */
  entityType: 'attendance' | 'group-member' | 'otp-request';
}

export interface CleanupAuditLogsPayload extends BaseJobPayload {
  /** Audit logs older than this many days are purged */
  olderThanDays: number;
}
