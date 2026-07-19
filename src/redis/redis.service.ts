import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;
  private _isConnected = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      password: this.configService.get<string>('redis.password'),
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 100, 3000),
    });

    this.client.on('connect', () => {
      this._isConnected = true;
      this.logger.log('Redis connected');
    });
    this.client.on('ready', () => { this._isConnected = true; });
    this.client.on('close', () => {
      this._isConnected = false;
      this.logger.warn('Redis connection closed');
    });
    this.client.on('error', (err) => {
      this._isConnected = false;
      this.logger.error('Redis error', err.message);
    });
  }

  async onModuleDestroy() {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
    await this.client.quit();
    this.logger.log('Redis disconnected');
  }

  // ── Cache-invalidation bus (2026-07-19) ────────────────────────────────────
  // Event-driven cache coherence across PM2 workers: a mutation site publishes
  // on a channel, every worker's subscriber drops its in-process L1 entry
  // within ~1-2ms — TTLs remain as the safety net, the bus makes propagation
  // instant (the scaled-down Meta memcache-invalidation-pipeline model).
  // Fail-soft by Governance Law #17: publish/subscribe failures degrade to
  // exactly the pre-bus TTL behavior, never break a request.
  // CACHE_INVAL_BUS=0 disables both directions (default on).

  private subscriber: Redis | null = null;
  private readonly subscribedChannels = new Set<string>();
  // Handler registry: ONE 'message' listener total dispatches to all
  // registered handlers (guards are instantiated per Nest module context, so
  // many instances may subscribe — a listener per instance would trip Node's
  // MaxListenersExceededWarning; a registry keeps it clean at any count).
  private readonly invalidationHandlers = new Map<
    string,
    Array<(payload: string) => void>
  >();
  private static busEnabled(): boolean {
    return (process.env.CACHE_INVAL_BUS ?? '1') !== '0';
  }

  /** Broadcast an invalidation event to every worker. Fire-and-forget safe. */
  async publishInvalidation(channel: string, payload: string): Promise<void> {
    if (!RedisService.busEnabled()) return;
    try {
      await this.client.publish(channel, payload);
    } catch (err) {
      this.logger.warn(
        `invalidation publish failed (TTL fallback governs): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Register a handler for an invalidation channel. Uses ONE dedicated
   * subscriber connection (Redis subscribers block their connection) shared
   * by all channels, created lazily on first use. Handler errors are isolated.
   */
  subscribeInvalidation(channel: string, handler: (payload: string) => void): void {
    if (!RedisService.busEnabled()) return;
    try {
      if (!this.subscriber) {
        this.subscriber = this.client.duplicate();
        this.subscriber.on('error', (err) =>
          this.logger.warn(`invalidation subscriber error: ${err.message}`),
        );
        // The ONLY message listener — dispatches to the handler registry.
        this.subscriber.on('message', (ch: string, msg: string) => {
          const handlers = this.invalidationHandlers.get(ch);
          if (!handlers) return;
          for (const h of handlers) {
            try {
              h(msg);
            } catch {
              /* one bad handler must never affect the bus */
            }
          }
        });
      }
      const list = this.invalidationHandlers.get(channel) ?? [];
      list.push(handler);
      this.invalidationHandlers.set(channel, list);
      if (!this.subscribedChannels.has(channel)) {
        this.subscribedChannels.add(channel);
        void this.subscriber.subscribe(channel).catch((err: Error) => {
          this.logger.warn(
            `invalidation subscribe failed (TTL fallback governs): ${err.message}`,
          );
        });
      }
    } catch (err) {
      this.logger.warn(
        `invalidation bus unavailable (TTL fallback governs): ${(err as Error).message}`,
      );
    }
  }

  // ── Connection state ──────────────────────────────────────────────────────

  get isConnected(): boolean {
    return this._isConnected && this.client.status === 'ready';
  }

  // ── Generic cache operations (gracefully degrade on Redis failure) ─────────
  //
  // Governance Law #17: Redis failure MUST NEVER break auth, attendance,
  // CRUD, analytics, exports. Cache operations (get/set) return null/void on
  // error so callers fall through to PostgreSQL queries naturally.

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`Redis GET failed key=${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
    } catch (err) {
      this.logger.warn(`Redis SET failed key=${key}: ${(err as Error).message}`);
      // Non-fatal: callers continue without caching
    }
  }

  async del(...keys: string[]): Promise<void> {
    try {
      if (keys.length) await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(`Redis DEL failed keys=${keys.join(',')}: ${(err as Error).message}`);
      // Non-fatal: stale cache entries will expire via TTL
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (err) {
      this.logger.warn(`Redis EXISTS failed key=${key}: ${(err as Error).message}`);
      return false;
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.expire(key, ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis EXPIRE failed key=${key}: ${(err as Error).message}`);
    }
  }

  // setNx used for deduplication — returns false on error (safe: DB unique constraint backs this up)
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.warn(`Redis SETNX failed key=${key}: ${(err as Error).message}`);
      // Return false so caller treats it as "already exists" — conservative/safe fallback
      return false;
    }
  }

  // ── Refresh token family operations (security-critical — do NOT degrade) ───
  //
  // These operations MUST throw on Redis failure — token security depends on
  // being able to revoke families. Auth service catches errors and returns 401.

  async revokeFamily(family: string): Promise<void> {
    await this.set(`revoked:family:${family}`, '1', 7 * 24 * 60 * 60);
  }

  async isFamilyRevoked(family: string): Promise<boolean> {
    return this.exists(`revoked:family:${family}`);
  }

  async addTokenToFamily(family: string, tokenHash: string, ttlSeconds: number): Promise<void> {
    await this.client.sadd(`family:${family}:tokens`, tokenHash);
    await this.client.expire(`family:${family}:tokens`, ttlSeconds);
  }

  async isTokenInFamily(family: string, tokenHash: string): Promise<boolean> {
    try {
      const result = await this.client.sismember(`family:${family}:tokens`, tokenHash);
      return result === 1;
    } catch (err) {
      this.logger.warn(`Redis SISMEMBER failed: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

  async increment(key: string, ttlSeconds: number): Promise<number> {
    try {
      const pipe = this.client.pipeline();
      pipe.incr(key);
      pipe.expire(key, ttlSeconds);
      const results = await pipe.exec();
      return results?.[0]?.[1] as number ?? 0;
    } catch (err) {
      this.logger.warn(`Redis INCREMENT failed key=${key}: ${(err as Error).message}`);
      return 0; // Returns 0 — rate limiter will allow request through on Redis failure
    }
  }

  // ── Deduplication (attendance race condition protection) ───────────────────

  async setDedup(key: string, ttlSeconds: number): Promise<boolean> {
    return this.setNx(key, '1', ttlSeconds);
  }

  // ── Pattern-based deletion (SCAN-based — never use KEYS in production) ─────

  async deletePattern(pattern: string): Promise<number> {
    try {
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
    } catch (err) {
      this.logger.warn(`Redis SCAN+DEL failed pattern=${pattern}: ${(err as Error).message}`);
      return 0;
    }
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
