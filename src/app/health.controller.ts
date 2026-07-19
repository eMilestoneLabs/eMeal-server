import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { Public } from '../common/decorators/public.decorator';

/** Result of one DB/Redis/queue probe wave (cached between hits). */
interface HealthProbes {
  database: 'connected' | 'disconnected';
  redis: 'connected' | 'disconnected';
  queues: Record<string, unknown>;
  allHealthy: boolean;
}

@Controller('health')
export class HealthController {
  // Probe micro-cache (env HEALTH_CACHE_TTL_MS, default 1000; 0 = legacy
  // per-hit probes). /health is hammered by uptime monitors, the PM2 warm-up,
  // and load floods: within the TTL every hit reuses ONE DB/Redis/queue probe
  // wave instead of paying its own round-trips, and an in-flight guard makes
  // concurrent hits share a single refresh (no probe stampede under 1000-VU
  // floods). Outages still surface within ~1s — the TTL bounds staleness.
  private static readonly CACHE_TTL_MS = parseInt(
    process.env.HEALTH_CACHE_TTL_MS ?? '1000',
    10,
  );
  private probeCache: { at: number; probes: HealthProbes } | null = null;
  private probeInFlight: Promise<HealthProbes> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * GET /api/v1/health
   * UptimeRobot pings this every 60s (Phase B8).
   * Returns database, redis, and queue connectivity status.
   */
  @Public()
  @Get()
  async check() {
    const probes = await this.getProbes();
    return {
      status: probes.allHealthy ? 'ok' : 'degraded',
      database: probes.database,
      redis: probes.redis,
      queues: probes.queues,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }

  /** Serves probes from the micro-cache; refreshes at most once per TTL. */
  private async getProbes(): Promise<HealthProbes> {
    const ttl = HealthController.CACHE_TTL_MS;
    if (ttl > 0 && this.probeCache && Date.now() - this.probeCache.at < ttl) {
      return this.probeCache.probes;
    }
    // Concurrent callers share one refresh instead of stampeding the DB.
    if (ttl > 0 && this.probeInFlight) return this.probeInFlight;

    const refresh = this.runProbes()
      .then((probes) => {
        this.probeCache = { at: Date.now(), probes };
        return probes;
      })
      .finally(() => {
        this.probeInFlight = null;
      });
    if (ttl > 0) this.probeInFlight = refresh;
    return refresh;
  }

  /** One real probe wave — identical checks to the legacy per-hit path. */
  private async runProbes(): Promise<HealthProbes> {
    const [dbOk, redisOk, queueMetrics] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
      this.queueService.getQueueMetrics(),
    ]);

    const database =
      dbOk.status === 'fulfilled' ? 'connected' : 'disconnected';
    const redisStatus =
      redisOk.status === 'fulfilled' && redisOk.value === true
        ? 'connected'
        : 'disconnected';
    const queues =
      queueMetrics.status === 'fulfilled'
        ? queueMetrics.value
        : { error: 'unavailable' };

    return {
      database,
      redis: redisStatus,
      queues: queues as Record<string, unknown>,
      allHealthy: database === 'connected' && redisStatus === 'connected',
    };
  }
}
