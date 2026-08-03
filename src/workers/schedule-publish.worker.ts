import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_NAMES } from '../queue/constants/queue.constants';
import { PrismaService } from '../prisma/prisma.service';

export interface SchedulePublishJobData {
  organizationId: string;
  scheduleId: string;
  groupId: string;
  requestId?: string;
}

/**
 * SchedulePublishWorker — B6 Phase
 *
 * Processes deferred schedule publish jobs from schedule-publish-queue.
 * Marks a MealSchedule as published at the scheduled time.
 * Idempotent: safe to retry — re-publishing an already-published schedule is a no-op.
 *
 * Uses a dedicated SCHEDULE_PUBLISH queue to avoid sharing the CLEANUP queue
 * with CleanupWorker (which would cause all cleanup jobs to be processed by
 * this worker as well, leading to duplicate processing).
 *
 * ⚠️ Live-Test-16 (L4) — DORMANT + BYPASSES SchedulesService.
 * As of 2026-08-03 NOTHING enqueues to this queue: `.add()` is never called on
 * SCHEDULE_PUBLISH anywhere in src/, so this processor never runs. It writes
 * `isPublished`/`publishedAt` straight through Prisma, which means it would
 * SKIP two invariants the HTTP publish path enforces:
 *   1. ISSUE-2 — the attendance-window validation (no overlap, minimum gap);
 *   2. ISSUE-1 — stamping `groups.firstSchedulePublishedAt`, the event that
 *      permanently locks the group's Meal-Pricing mode.
 * Left untouched deliberately: there is no live defect, and rewriting working
 * (if unused) code would be an unjustified change. BEFORE wiring any producer
 * to this queue, route the publish through `SchedulesService.publishSchedule`
 * so both invariants still hold.
 */
@Processor(QUEUE_NAMES.SCHEDULE_PUBLISH, { concurrency: 2 })
export class SchedulePublishWorker extends WorkerHost {
  private readonly logger = new Logger(SchedulePublishWorker.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<SchedulePublishJobData>): Promise<void> {
    const { organizationId, scheduleId, groupId, requestId } = job.data;
    this.logger.log(
      `[schedulePublish] jobId=${job.id} scheduleId=${scheduleId} orgId=${organizationId} requestId=${requestId}`,
    );

    if (!scheduleId || !organizationId) {
      this.logger.warn(`[schedulePublish] Invalid payload — missing scheduleId or organizationId`);
      return;
    }

    const schedule = await this.prisma.mealSchedule.findFirst({
      where: {
        id: scheduleId,
        organizationId, // org isolation — CRITICAL
        groupId,
      },
      select: { id: true, isPublished: true },
    });

    if (!schedule) {
      this.logger.warn(`[schedulePublish] Schedule ${scheduleId} not found — may have been deleted`);
      return; // Idempotent: missing schedule = already cleaned up
    }

    if (schedule.isPublished) {
      this.logger.debug(`[schedulePublish] Schedule ${scheduleId} already published — no-op`);
      return; // Idempotent
    }

    await this.prisma.mealSchedule.update({
      where: { id: scheduleId },
      data: {
        isPublished: true,
        publishedAt: new Date(),
      },
    });

    this.logger.log(
      `[schedulePublish] Schedule ${scheduleId} published for org=${organizationId} group=${groupId}`,
    );
  }
}
