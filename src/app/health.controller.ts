import { Controller, Get } from '@nestjs/common';
import { monitorEventLoopDelay } from 'perf_hooks';
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

// Stall forensics (2026-07-19): request tails (p95 spikes with unchanged
// mins, a DIFFERENT endpoint set slow on every audit run, and /health —
// an in-memory cache read — showing 400ms outliers) point at stalls BELOW
// the app: either this worker's event loop pausing, or the shared vCPU
// being scheduled away (noisy neighbor / co-located containers). This
// histogram separates the two with hard data: `eventLoop.max` ≈ request
// tail → in-process stall (investigate app); `eventLoop.max` low while
// request tails stay high → the host paused us (vCPU steal / host noise —
// no application code can fix that). Sampled continuously at ~20ms
// resolution; numbers are ms since the previous /health read (reset each
// read so every sample covers a known window). Additive payload field.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const NS_PER_MS = 1e6;

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
  // SWR (2026-07-19): with plain TTL caching the one hit that lands after
  // expiry still pays the full DB+Redis+queue probe wave INLINE — that
  // refill hit IS the recurring "health p95>SLO by a few ms" audit failure
  // (p50 stays a memory read, p95 rides the probe). Stale-while-revalidate
  // serves the previous probe result immediately and refreshes in the
  // background, so after the first boot-time probe NO request ever waits on
  // a probe again. Staleness stays bounded by TTL + one probe duration
  // (~1-2s worst case) — irrelevant for 60s-interval uptime monitors, and
  // an outage still flips the payload to 'degraded' within ~1 extra hit.
  // HEALTH_CACHE_SWR=0 restores the legacy inline-refresh behavior.
  private static readonly SWR_ENABLED =
    (process.env.HEALTH_CACHE_SWR ?? '1') !== '0';
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
    // Event-loop lag over the window since the last /health read (ms).
    // mean/p99 ≈ 0-2ms and max small → loop healthy; a large max here that
    // matches a request-latency spike = in-process stall; small max while
    // requests spiked = the HOST paused this worker (vCPU steal).
    const eventLoop = {
      meanMs: +(loopDelay.mean / NS_PER_MS).toFixed(2),
      p99Ms: +(loopDelay.percentile(99) / NS_PER_MS).toFixed(2),
      maxMs: +(loopDelay.max / NS_PER_MS).toFixed(2),
    };
    loopDelay.reset();
    return {
      status: probes.allHealthy ? 'ok' : 'degraded',
      database: probes.database,
      redis: probes.redis,
      queues: probes.queues,
      eventLoop,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }

  /**
   * Serves probes from the micro-cache; refreshes at most once per TTL.
   * SWR mode (default): an expired cache is served AS-IS while ONE shared
   * background refresh runs — no request ever blocks on a probe wave after
   * the first. Legacy mode (HEALTH_CACHE_SWR=0): the expiry hit refreshes
   * inline exactly as before.
   */
  private async getProbes(): Promise<HealthProbes> {
    const ttl = HealthController.CACHE_TTL_MS;
    if (ttl > 0 && this.probeCache && Date.now() - this.probeCache.at < ttl) {
      return this.probeCache.probes;
    }
    // Concurrent callers share one refresh instead of stampeding the DB.
    if (ttl > 0 && this.probeInFlight) {
      // SWR: a stale value exists → serve it now; the shared refresh will
      // land for later hits. Without a cache (first boot) we must wait.
      if (HealthController.SWR_ENABLED && this.probeCache) {
        return this.probeCache.probes;
      }
      return this.probeInFlight;
    }

    const refresh = this.runProbes()
      .then((probes) => {
        this.probeCache = { at: Date.now(), probes };
        return probes;
      })
      .finally(() => {
        this.probeInFlight = null;
      });
    if (ttl > 0) this.probeInFlight = refresh;

    // SWR: kick the refresh off in the background and answer from the stale
    // cache immediately. runProbes never rejects (allSettled inside), but
    // guard anyway so an unexpected throw can't become an unhandled
    // rejection while we're not awaiting it.
    if (ttl > 0 && HealthController.SWR_ENABLED && this.probeCache) {
      refresh.catch(() => undefined);
      return this.probeCache.probes;
    }
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
