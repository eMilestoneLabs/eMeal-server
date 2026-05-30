import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { Public } from '../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
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
    const [dbOk, redisOk, queueMetrics] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
      this.queueService.getQueueMetrics(),
    ]);

    const database = dbOk.status === 'fulfilled' ? 'connected' : 'disconnected';
    const redisStatus =
      redisOk.status === 'fulfilled' && redisOk.value === true ? 'connected' : 'disconnected';

    const queues =
      queueMetrics.status === 'fulfilled' ? queueMetrics.value : { error: 'unavailable' };

    const allHealthy = database === 'connected' && redisStatus === 'connected';

    return {
      status: allHealthy ? 'ok' : 'degraded',
      database,
      redis: redisStatus,
      queues,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version ?? '1.0.0',
    };
  }
}
