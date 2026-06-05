import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface StaleTokenJobData {
  requestId?: string;
  olderThanDays?: number; // default 30 days
}

/**
 * StaleTokenService (formerly StaleTokenWorker) — B6 Phase
 *
 * Called directly by CleanupWorker for CLEANUP_STALE_TOKENS jobs.
 * NOT a BullMQ processor — removing @Processor prevents duplicate processing
 * with CleanupWorker (which also listens on cleanup-queue).
 *
 * Cleans up stale/expired refresh tokens from the database.
 * Also nullifies stale FCM tokens that have not been updated in > olderThanDays.
 *
 * Idempotent: deleting already-deleted rows is safe.
 */
@Injectable()
export class StaleTokenService {
  private readonly logger = new Logger(StaleTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(data: StaleTokenJobData = {}): Promise<void> {
    const { requestId, olderThanDays = 30 } = data;
    this.logger.log(`[staleToken] olderThanDays=${olderThanDays} requestId=${requestId}`);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    // 1. Delete expired refresh tokens (hard delete — per governance: refresh tokens = hard delete)
    const deletedTokens = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } }, // expired
          { isRevoked: true, createdAt: { lt: cutoff } }, // revoked + old
        ],
      },
    });

    this.logger.log(`[staleToken] Deleted ${deletedTokens.count} expired/revoked refresh tokens`);

    // 2. Nullify stale OTP requests (older than cutoff + already used)
    const deletedOtps = await this.prisma.otpRequest.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() }, isUsed: true },
          { expiresAt: { lt: cutoff } }, // very old — clean regardless
        ],
      },
    });

    this.logger.log(`[staleToken] Deleted ${deletedOtps.count} expired OTP requests`);
  }
}

// Backward-compat export alias (workers.module.ts references StaleTokenWorker)
export { StaleTokenService as StaleTokenWorker };
