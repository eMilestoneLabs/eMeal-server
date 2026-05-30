/**
 * analytics-aggregation.worker.ts — B6 Phase
 *
 * Processes jobs from analytics-queue.
 *
 * Job types handled:
 *   aggregate-daily — compute and cache daily attendance summary per org
 *   aggregate-group — compute group-level attendance stats for a date range
 *
 * Concurrency: 1 (sequential to avoid DB contention on GROUP BY queries)
 *
 * Idempotency:
 *   aggregate-daily: jobId = dedupKey prevents duplicate scheduling via BullMQ.
 *   Redis cache invalidated on completion so fresh data is available.
 *
 * Security:
 *   organizationId scoped in every query — no cross-org aggregation possible.
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';
import { toUtcMidnight } from '../common/utils/date.utils';
import type {
  AggregateDailyPayload,
  AggregateGroupPayload,
} from '../queue/interfaces/job-payload.interface';

// Cache TTL for aggregated analytics — 10 minutes
const ANALYTICS_CACHE_TTL = 600;

@Processor(QUEUE_NAMES.ANALYTICS, { concurrency: 1 })
export class AnalyticsAggregationWorker extends WorkerHost {
  private readonly logger = new Logger(AnalyticsAggregationWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case JOB_TYPES.AGGREGATE_DAILY:
        await this.handleAggregateDaily(job as Job<AggregateDailyPayload>);
        break;

      case JOB_TYPES.AGGREGATE_GROUP:
        await this.handleAggregateGroup(job as Job<AggregateGroupPayload>);
        break;

      default:
        this.logger.warn(`Unknown analytics job type: ${job.name}`);
    }
  }

  // ── aggregate-daily ─────────────────────────────────────────────────────────

  private async handleAggregateDaily(job: Job<AggregateDailyPayload>): Promise<void> {
    const { organizationId, date, dedupKey } = job.data;

    if (!organizationId) {
      throw new Error(`[AnalyticsWorker] Missing organizationId in job=${job.id}`);
    }

    this.logger.log(`Aggregating daily attendance org=${organizationId} date=${date}`);

    // Aggregate attendance counts for this date scoped to organization
    const summary = await this.prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: {
        meal: { group: { organizationId } },
        attendanceDate: toUtcMidnight(date),
      },
      _count: { status: true },
    });

    const result: Record<string, number> = {
      present: 0,
      absent: 0,
      skipped: 0,
      onVacation: 0,
    };

    for (const row of summary) {
      result[row.status] = row._count.status;
    }

    result.total = Object.values(result).reduce((a, b) => a + b, 0);
    result.date = date as any;
    result.organizationId = organizationId as any;

    // Cache the result
    const cacheKey = `analytics:daily:${organizationId}:${date}`;
    await this.redis.set(cacheKey, JSON.stringify(result), ANALYTICS_CACHE_TTL);

    this.logger.log(
      `Daily aggregation complete org=${organizationId} date=${date} ` +
      `present=${result.present} absent=${result.absent} total=${result.total}`,
    );
  }

  // ── aggregate-group ─────────────────────────────────────────────────────────

  private async handleAggregateGroup(job: Job<AggregateGroupPayload>): Promise<void> {
    const { organizationId, groupId, fromDate, toDate } = job.data;

    if (!organizationId) {
      throw new Error(`[AnalyticsWorker] Missing organizationId in job=${job.id}`);
    }

    this.logger.log(
      `Aggregating group attendance org=${organizationId} group=${groupId} ` +
      `from=${fromDate} to=${toDate}`,
    );

    // Per-day attendance counts for a group
    const rows = await this.prisma.attendanceRecord.groupBy({
      by: ['attendanceDate', 'status'],
      where: {
        meal: {
          groupId,
          group: { organizationId }, // org isolation
        },
        attendanceDate: {
          gte: new Date(fromDate),
          lte: new Date(toDate),
        },
      },
      _count: { status: true },
      orderBy: { attendanceDate: 'asc' },
    });

    const result = {
      organizationId,
      groupId,
      fromDate,
      toDate,
      byDate: rows.map((r) => ({
        date: r.attendanceDate.toISOString().slice(0, 10),
        status: r.status,
        count: r._count.status,
      })),
    };

    const cacheKey = `analytics:group:${organizationId}:${groupId}:${fromDate}:${toDate}`;
    await this.redis.set(cacheKey, JSON.stringify(result), ANALYTICS_CACHE_TTL);

    this.logger.log(
      `Group aggregation complete org=${organizationId} group=${groupId} rows=${rows.length}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Analytics job FAILED job=${job.id} type=${job.name} attempts=${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.debug(`Analytics job completed job=${job.id} type=${job.name}`);
  }
}
