import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions, Server } from 'socket.io';
import { Logger, INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * RedisIoAdapter — Socket.IO adapter with Redis pub/sub for horizontal scaling.
 *
 * Enables PM2 cluster-safe WebSocket broadcasts across multiple NestJS processes.
 * Each process publishes events to Redis; all instances forward to local sockets.
 *
 * PRODUCTION SETUP:
 *   npm install @socket.io/redis-adapter
 *   Then set REDIS_HOST / REDIS_PORT / REDIS_PASSWORD in .env
 *
 * FALLBACK:
 *   If @socket.io/redis-adapter is not installed (dev / sandbox),
 *   falls back to IoAdapter (in-memory, single-process only).
 *   No crash — just logs a warning.
 *
 * Usage in main.ts:
 *   const adapter = new RedisIoAdapter(app);
 *   await adapter.connectToRedis();
 *   app.useWebSocketAdapter(adapter);
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: any;
  private readonly app: INestApplicationContext;

  constructor(app: INestApplicationContext) {
    super(app);
    this.app = app;
  }

  async connectToRedis(): Promise<void> {
    const config = this.app.get(ConfigService);
    const redisHost = config.get<string>('redis.host') ?? 'localhost';
    const redisPort = config.get<number>('redis.port') ?? 6379;
    const redisPassword = config.get<string>('redis.password');

    try {
      // Dynamic require — avoids compile-time failure if package not installed
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createAdapter } = require('@socket.io/redis-adapter');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const IORedis = require('ioredis');

      const pubClient = new IORedis({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        lazyConnect: false,
        retryStrategy: (times: number) => Math.min(times * 100, 3000),
      });

      const subClient = pubClient.duplicate();

      // Wait for both connections to be ready before attaching
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          pubClient.once('ready', resolve);
          pubClient.once('error', reject);
        }),
        new Promise<void>((resolve, reject) => {
          subClient.once('ready', resolve);
          subClient.once('error', reject);
        }),
      ]);

      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log(
        `Redis Socket.IO adapter connected — redis=${redisHost}:${redisPort}`,
      );
    } catch (err: any) {
      if (err?.code === 'MODULE_NOT_FOUND') {
        this.logger.warn(
          '@socket.io/redis-adapter not installed — falling back to in-memory IoAdapter. ' +
          'Run: npm install @socket.io/redis-adapter for production horizontal scaling.',
        );
      } else {
        this.logger.error(
          `Redis adapter connection failed — falling back to in-memory IoAdapter: ${err?.message}`,
        );
      }
      // Fallback: adapterConstructor remains undefined → standard in-memory adapter
    }
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
      this.logger.log('Socket.IO using Redis pub/sub adapter (cluster-safe)');
    } else {
      this.logger.log('Socket.IO using in-memory adapter (single-process)');
    }
    return server;
  }
}
