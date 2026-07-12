import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Boot warmup — kills the post-reload cold-start latency spike.
 *
 * After every PM2 reload the first benchmark pass showed p95s far above the
 * golden bands (/dashboard/admin/overview 465ms vs the warm 135ms) because
 * each fresh worker pays one-time costs on its first real requests: Prisma
 * engine spin-up, pool connection establishment, per-model query compilation
 * and V8 JIT. The deploy script's unauthenticated /health hits cannot warm
 * authenticated query paths — so each worker primes itself here, at
 * bootstrap, before real traffic lands on it.
 *
 * Fire-and-forget: warmup must never delay or block startup, and a failure
 * (e.g. DB briefly unavailable during boot) is logged and ignored — the
 * health check governs readiness, not this.
 *
 * WARMUP_ON_BOOT=0 disables (default on).
 */
@Injectable()
export class WarmupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WarmupService.name);
  private readonly enabled = (process.env.WARMUP_ON_BOOT ?? '1') !== '0';

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService | null,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Boot warmup disabled (WARMUP_ON_BOOT=0)');
      return;
    }
    void this.run().catch((err: Error) => {
      this.logger.warn(`Boot warmup skipped: ${err.message}`);
    });
  }

  private async run(): Promise<void> {
    const t0 = Date.now();

    // Connection + engine handshake first, then the hot read models touched
    // by the dashboard/attendance/billing/notices surfaces in parallel. Each
    // is a cheapest-possible indexed read — the value is the one-time
    // per-model compile + pooled connections, not the data.
    await this.prisma.$queryRaw`SELECT 1`;
    await Promise.all([
      this.prisma.user.findFirst({ select: { id: true } }),
      this.prisma.group.findFirst({ select: { id: true } }),
      this.prisma.groupMember.findFirst({ select: { id: true } }),
      this.prisma.meal.findFirst({ select: { id: true } }),
      this.prisma.attendanceRecord.findFirst({ select: { id: true } }),
      this.prisma.mealSchedule.findFirst({ select: { id: true } }),
      this.prisma.notice.findFirst({ select: { id: true } }),
      this.prisma.vacationRequest.findFirst({ select: { id: true } }),
      this.prisma.refreshToken.findFirst({ select: { id: true } }),
      this.redis?.ping().catch(() => false) ?? Promise.resolve(false),
    ]);

    this.logger.log(`Boot warmup completed in ${Date.now() - t0}ms`);
  }
}
