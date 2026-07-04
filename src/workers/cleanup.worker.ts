/**
 * cleanup.worker.ts — B6 Phase
 *
 * Processes jobs from cleanup-queue.
 *
 * Job types handled:
 *   cleanup-stale-tokens    — purge FCM tokens from users inactive > N days
 *   cleanup-expired-events  — soft-delete events past their autoDeleteAt date
 *   cleanup-orphan-records  — remove dangling attendance/otp/member records
 *   cleanup-audit-logs      — purge old audit log entries past retention window
 *
 * Concurrency: 1 (sequential for data safety)
 *
 * Idempotency: BullMQ jobId = dedupKey ensures each cleanup type runs once
 * per day per org. Redis also checked via setDedup for extra safety.
 *
 * Security:
 *   - Every operation scoped by organizationId
 *   - Uses Prisma deleteMany/updateMany — never raw SQL
 *   - Audit log written after cleanup for traceability
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';
import {
  getTodayInTimezone,
  toUtcMidnight,
} from '../common/utils/date.utils';
import type {
  CleanupStaleTokensPayload,
  CleanupExpiredEventsPayload,
  CleanupOrphanRecordsPayload,
  CleanupAuditLogsPayload,
} from '../queue/interfaces/job-payload.interface';

const CLEANUP_DEDUP_TTL = 12 * 60 * 60; // 12 hours

@Processor(QUEUE_NAMES.CLEANUP, { concurrency: 1 })
export class CleanupWorker extends WorkerHost {
  private readonly logger = new Logger(CleanupWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing cleanup job=${job.id} type=${job.name}`);

    switch (job.name) {
      case JOB_TYPES.CLEANUP_STALE_TOKENS:
        await this.handleStaleTokens(job as Job<CleanupStaleTokensPayload>);
        break;

      case JOB_TYPES.CLEANUP_EXPIRED_EVENTS:
        await this.handleExpiredEvents(job as Job<CleanupExpiredEventsPayload>);
        break;

      case JOB_TYPES.CLEANUP_ORPHAN_RECORDS:
        await this.handleOrphanRecords(job as Job<CleanupOrphanRecordsPayload>);
        break;

      case JOB_TYPES.CLEANUP_AUDIT_LOGS:
        await this.handleAuditLogs(job as Job<CleanupAuditLogsPayload>);
        break;

      default:
        this.logger.warn(`Unknown cleanup job type: ${job.name}`);
    }
  }

  // ── Stale FCM token cleanup ────────────────────────────────────────────────

  private async handleStaleTokens(job: Job<CleanupStaleTokensPayload>): Promise<void> {
    const { organizationId, olderThanDays, dedupKey } = job.data;

    if (!organizationId) throw new Error(`Missing organizationId job=${job.id}`);

    const alreadyRun = !(await this.redis.setDedup(`cleanup:stale-tokens:${dedupKey}`, CLEANUP_DEDUP_TTL));
    if (alreadyRun) {
      this.logger.debug(`Stale token cleanup already ran today — skipping job=${job.id}`);
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    // Clear FCM tokens for users in this org who haven't logged in recently
    const result = await this.prisma.user.updateMany({
      where: {
        organizationId,
        fcmToken: { not: null },
        lastLoginAt: { lt: cutoffDate },
        isActive: true,
      },
      data: { fcmToken: null },
    });

    // Also clean expired OTP requests for this org's users
    const otpResult = await this.prisma.otpRequest.deleteMany({
      where: {
        user: { organizationId },
        expiresAt: { lt: new Date() },
      },
    });

    this.logger.log(
      `Stale token cleanup org=${organizationId} ` +
      `tokensCleared=${result.count} expiredOtps=${otpResult.count}`,
    );
  }

  // ── Expired event cleanup ──────────────────────────────────────────────────

  private async handleExpiredEvents(job: Job<CleanupExpiredEventsPayload>): Promise<void> {
    const { organizationId, cutoffDate, dedupKey } = job.data;

    if (!organizationId) throw new Error(`Missing organizationId job=${job.id}`);

    const alreadyRun = !(await this.redis.setDedup(`cleanup:expired-events:${dedupKey}`, CLEANUP_DEDUP_TTL));
    if (alreadyRun) {
      this.logger.debug(`Expired event cleanup already ran — skipping job=${job.id}`);
      return;
    }

    // Soft-delete events past their autoDeleteAt date
    const result = await this.prisma.event.updateMany({
      where: {
        organizationId,
        autoDeleteAfter7Days: true,
        autoDeleteAt: { lt: new Date(cutoffDate) },
        isActive: true,
      },
      data: { isActive: false },
    });

    // ── Pass 14 (FR-EVTX-023 / FR-DLC-004 / LOOP-073 / SC-074) ───────────────
    // Stage 2: HARD-purge. The authoritative instant is date-based in the
    // EVENT's timezone (= org timezone): once the org-local date is more than
    // 7 days past eventDate, the event row is deleted — cascades wipe meal
    // types, guest parties, persons, and the QR join token dies with the row.
    // Date math (not instant math) makes this DST-robust, and deleteMany is
    // naturally idempotent if the job runs late or twice (LOOP-073).
    let purged = 0;
    try {
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      });
      const tz = org?.timezone ?? 'Asia/Kolkata';
      const orgToday = toUtcMidnight(getTodayInTimezone(tz));
      const purgeCutoff = new Date(orgToday.getTime() - 7 * 24 * 60 * 60 * 1000);

      const purgeResult = await this.prisma.event.deleteMany({
        where: {
          organizationId,
          autoDeleteAfter7Days: true,
          eventDate: { lt: purgeCutoff },
        },
      });
      purged = purgeResult.count;

      if (purged > 0) {
        // Append-only trace that the purge happened (the data itself is gone).
        await this.prisma.auditLog.create({
          data: {
            organizationId,
            targetType: 'Event',
            action: 'delete',
            metadata: {
              autoDeleteHardPurge: true,
              purgedEvents: purged,
              timezone: tz,
              purgeCutoff: purgeCutoff.toISOString(),
            } as any,
          },
        });
      }
    } catch (err) {
      // Purge failure must never fail the whole cleanup job — next run retries.
      this.logger.error(
        `Event hard-purge failed org=${organizationId}: ${(err as Error).message}`,
      );
    }

    // ── Pass 14 (LOOP-081 / FR-HG-075): hosted-guest PII retention ──────────
    // Guest display names are minimized after the retention window (billing
    // keeps working — amounts live in priceSnapshot, not the name).
    let piiCleared = 0;
    const retentionDays = parseInt(
      process.env.GUEST_PII_RETENTION_DAYS ?? '180',
      10,
    );
    if (retentionDays > 0) {
      try {
        const piiCutoff = new Date(
          Date.now() - retentionDays * 24 * 60 * 60 * 1000,
        );
        const piiResult = await (this.prisma as any).mealGuest.updateMany({
          where: {
            organizationId,
            attendanceDate: { lt: piiCutoff },
            displayName: { not: null },
          },
          data: { displayName: null },
        });
        piiCleared = piiResult.count;
      } catch (err) {
        this.logger.error(
          `Guest PII retention failed org=${organizationId}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Expired event cleanup org=${organizationId} eventsDeactivated=${result.count} ` +
        `hardPurged=${purged} guestNamesMinimized=${piiCleared} cutoff=${cutoffDate}`,
    );
  }

  // ── Orphan record cleanup ──────────────────────────────────────────────────

  private async handleOrphanRecords(job: Job<CleanupOrphanRecordsPayload>): Promise<void> {
    const { organizationId, entityType, dedupKey } = job.data;

    if (!organizationId) throw new Error(`Missing organizationId job=${job.id}`);

    const alreadyRun = !(await this.redis.setDedup(`cleanup:orphan:${dedupKey}`, CLEANUP_DEDUP_TTL));
    if (alreadyRun) {
      this.logger.debug(`Orphan cleanup already ran — skipping job=${job.id}`);
      return;
    }

    let count = 0;

    switch (entityType) {
      case 'otp-request': {
        // Remove OTP requests older than 24 hours for this org's users
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const result = await this.prisma.otpRequest.deleteMany({
          where: {
            user: { organizationId },
            createdAt: { lt: cutoff },
          },
        });
        count = result.count;
        break;
      }

      case 'group-member': {
        // Remove GroupMember rows where user no longer belongs to org
        // (edge case: org transfer or user deletion without cascade)
        const result = await this.prisma.groupMember.deleteMany({
          where: {
            group: { organizationId },
            user: { isActive: false },
          },
        });
        count = result.count;
        break;
      }

      default:
        this.logger.warn(`Unknown orphan entity type: ${entityType}`);
        return;
    }

    this.logger.log(
      `Orphan cleanup org=${organizationId} entityType=${entityType} removed=${count}`,
    );
  }

  // ── Audit log cleanup ──────────────────────────────────────────────────────

  private async handleAuditLogs(job: Job<CleanupAuditLogsPayload>): Promise<void> {
    const { organizationId, olderThanDays, dedupKey } = job.data;

    if (!organizationId) throw new Error(`Missing organizationId job=${job.id}`);

    const alreadyRun = !(await this.redis.setDedup(`cleanup:audit:${dedupKey}`, CLEANUP_DEDUP_TTL));
    if (alreadyRun) {
      this.logger.debug(`Audit log cleanup already ran — skipping job=${job.id}`);
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        organizationId,
        createdAt: { lt: cutoffDate },
      },
    });

    this.logger.log(
      `Audit log cleanup org=${organizationId} deleted=${result.count} ` +
      `olderThan=${olderThanDays}days cutoff=${cutoffDate.toISOString()}`,
    );
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Cleanup job FAILED job=${job.id} type=${job.name} attempts=${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.debug(`Cleanup job completed job=${job.id} type=${job.name}`);
  }
}
