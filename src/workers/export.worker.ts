/**
 * export.worker.ts — B6 Phase
 *
 * Processes jobs from export-queue.
 *
 * Job types handled:
 *   generate-export — async large-data CSV/XLSX generation
 *
 * MVP: logs export intent. Full implementation in B7 (large export streaming
 * to Cloudflare R2 + pre-signed URL delivery).
 *
 * Concurrency: 2 (two concurrent exports maximum)
 *
 * Security:
 *   - organizationId in every query
 *   - requesting user's role validated against allowed admin roles
 *   - export data never stored beyond TTL
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';
import type { GenerateExportPayload } from '../queue/interfaces/job-payload.interface';

const ADMIN_ROLES = ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager', 'eventAdmin'];

@Processor(QUEUE_NAMES.EXPORT, { concurrency: 2 })
export class ExportWorker extends WorkerHost {
  private readonly logger = new Logger(ExportWorker.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === JOB_TYPES.GENERATE_EXPORT) {
      await this.handleGenerateExport(job as Job<GenerateExportPayload>);
    }
  }

  private async handleGenerateExport(job: Job<GenerateExportPayload>): Promise<void> {
    const {
      organizationId,
      exportType,
      format,
      groupId,
      eventId,
      fromDate,
      toDate,
      requestingUserId,
      dedupKey,
    } = job.data;

    if (!organizationId) {
      throw new Error(`[ExportWorker] Missing organizationId job=${job.id}`);
    }

    this.logger.log(
      `Export job started job=${job.id} type=${exportType} ` +
      `format=${format} org=${organizationId} user=${requestingUserId}`,
    );

    // Validate requesting user still exists and has admin role
    const user = await this.prisma.user.findFirst({
      where: { id: requestingUserId, organizationId, isActive: true },
      select: { role: true },
    });

    if (!user || !ADMIN_ROLES.includes(user.role)) {
      this.logger.warn(
        `Export rejected: user=${requestingUserId} no longer has admin role job=${job.id}`,
      );
      return; // Resolve cleanly — stale export request
    }

    // Fetch export data (scoped to org)
    let recordCount = 0;

    if (exportType === 'attendance' && groupId) {
      const count = await this.prisma.attendanceRecord.count({
        where: {
          meal: {
            groupId,
            group: { organizationId }, // org isolation
          },
          ...(fromDate && toDate
            ? {
                attendanceDate: {
                  gte: new Date(fromDate),
                  lte: new Date(toDate),
                },
              }
            : {}),
        },
      });
      recordCount = count;

      // MVP: log the export data size
      // B7: stream records to exceljs/csv builder → upload to Cloudflare R2
      this.logger.log(
        `Attendance export job=${job.id} group=${groupId} records=${recordCount} ` +
        `format=${format} — MVP: sync export via /exports/attendance endpoint`,
      );

    } else if (exportType === 'event-guests' && eventId) {
      const count = await this.prisma.eventPerson.count({
        where: { party: { event: { id: eventId, organizationId } } },
      });
      recordCount = count;

      this.logger.log(
        `Event guest export job=${job.id} event=${eventId} records=${recordCount} ` +
        `format=${format} — MVP: sync export via /exports/event-guests endpoint`,
      );
    }

    this.logger.log(
      `Export job completed job=${job.id} type=${exportType} records=${recordCount}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `Export job FAILED job=${job.id} attempts=${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }
}
