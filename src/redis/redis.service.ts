import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      password: this.configService.get<string>('redis.password'),
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });

    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('error', (err) => this.logger.error('Redis error', err));
  }

  async onModuleDestroy() {
    await this.client.quit();
    this.logger.log('Redis disconnected');
  }

  // ── Generic operations ────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  // Set with NX (set if not exists) — returns true if set, false if key existed
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  // ── Refresh token family operations ──────────────────────────────────────

  // Revoke an entire token family (logout / theft detection)
  async revokeFamily(family: string): Promise<void> {
    await this.set(`revoked:family:${family}`, '1', 7 * 24 * 60 * 60);
  }

  async isFamilyRevoked(family: string): Promise<boolean> {
    return this.exists(`revoked:family:${family}`);
  }

  // Track individual token hash in family
  async addTokenToFamily(family: string, tokenHash: string, ttlSeconds: number): Promise<void> {
    await this.client.sadd(`family:${family}:tokens`, tokenHash);
    await this.client.expire(`family:${family}:tokens`, ttlSeconds);
  }

  async isTokenInFamily(family: string, tokenHash: string): Promise<boolean> {
    const result = await this.client.sismember(`family:${family}:tokens`, tokenHash);
    return result === 1;
  }

  // ── Rate limiting helpers ──────────────────────────────────────────────────

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const pipe = this.client.pipeline();
    pipe.incr(key);
    pipe.expire(key, ttlSeconds);
    const results = await pipe.exec();
    return results?.[0]?.[1] as number ?? 0;
  }

  // ── Deduplication (attendance race condition protection) ──────────────────

  async setDedup(key: string, ttlSeconds: number): Promise<boolean> {
    return this.setNx(key, '1', ttlSeconds);
  }

  // ── Pattern-based deletion (SCAN-based — never use KEYS in production) ─────

  /**
   * Delete all keys matching a glob pattern using SCAN + DEL pipeline.
   * Safe for production — SCAN uses cursor-based iteration, non-blocking.
   * Use for cache invalidation when key includes dynamic date ranges:
   *   e.g. deletePattern('analytics:attendance:orgId:groupId:*')
   */
  async deletePattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deletedCount = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.client.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== '0');

    return deletedCount;
  }

  // ── Ping / health check ───────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
