import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface OrphanCleanupJobData {
  requestId?: string;
}

/**
 * OrphanService (formerly OrphanWorker) — B6 Phase
 *
 * Called directly by CleanupWorker for CLEANUP_ORPHAN_RECORDS jobs.
 * NOT a BullMQ processor — removing @Processor prevents duplicate processing
 * with CleanupWorker (which also listens on cleanup-queue).
 *
 * Cleans up orphaned records that may result from partial operations:
 *   - EventGuestParties with no associated persons
 *   - Events past autoDeleteAt that are still active
 *   - GroupMembers where the user no longer exists
 *
 * Idempotent: safe to retry — re-cleaning already-cleaned records is a no-op.
 */
@Injectable()
export class OrphanService {
  private readonly logger = new Logger(OrphanService.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(data: OrphanCleanupJobData = {}): Promise<void> {
    const { requestId } = data;
    this.logger.log(`[orphanCleanup] requestId=${requestId}`);

    await Promise.all([
      this.cleanAutoDeleteEvents(),
      this.cleanOrphanedGuestParties(),
    ]);
  }

  private async cleanAutoDeleteEvents(): Promise<void> {
    const now = new Date();

    const expiredEvents = await this.prisma.event.findMany({
      where: {
        autoDeleteAfter7Days: true,
        autoDeleteAt: { lte: now },
        isActive: true,
      },
      select: { id: true, organizationId: true, name: true },
    });

    if (expiredEvents.length === 0) return;

    // Soft-delete: mark isActive = false (per governance: events use soft delete)
    await this.prisma.event.updateMany({
      where: {
        id: { in: expiredEvents.map((e) => e.id) },
      },
      data: { isActive: false },
    });

    this.logger.log(
      `[orphanCleanup] Soft-deleted ${expiredEvents.length} auto-expired events`,
    );
  }

  private async cleanOrphanedGuestParties(): Promise<void> {
    // EventGuestParties with 0 persons (failed partial registration)
    const orphanParties = await this.prisma.eventGuestParty.findMany({
      where: {
        persons: { none: {} },
        // Only clean up parties older than 1 hour (avoid race conditions)
        joinedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
      },
      select: { id: true, eventId: true },
    });

    if (orphanParties.length === 0) return;

    await this.prisma.eventGuestParty.deleteMany({
      where: { id: { in: orphanParties.map((p) => p.id) } },
    });

    this.logger.log(
      `[orphanCleanup] Deleted ${orphanParties.length} orphaned guest parties`,
    );
  }
}

// Backward-compat export alias (workers.module.ts references OrphanWorker)
export { OrphanService as OrphanWorker };
