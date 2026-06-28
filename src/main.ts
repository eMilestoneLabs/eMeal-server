import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as compression from 'compression';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app/app.module';
import { setupBullBoard } from './app/bull-board.setup';
import { RedisIoAdapter } from './realtime/adapters/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
    bufferLogs: false,
    // Disable the default 100kb body parser; a larger limit is set below so
    // base64 image uploads (meal/schedule photos) aren't rejected with 413.
    bodyParser: false,
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port') ?? 3000;
  const nodeEnv = config.get<string>('app.nodeEnv') ?? 'development';

  // ── Security middleware ────────────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginEmbedderPolicy: nodeEnv === 'production',
      contentSecurityPolicy: nodeEnv === 'production',
    }),
  );
  app.use(compression());

  // ── Body parsing (raised limit) ────────────────────────────────────────────
  // Meal/schedule photos are sent as base64 in the JSON body; the Express
  // default (100kb) rejected them with 413. Match Nginx's client_max_body_size
  // (5M) so legitimate uploads succeed while oversized bodies stay capped at
  // the proxy.
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  // Behind Nginx (the sole ingress) trust the first proxy hop so Express
  // derives the real client IP from X-Forwarded-For. Without this, every
  // request appears to come from 127.0.0.1 and per-IP rate limiting
  // (ThrottlerGuard on login/OTP) collapses into a single global counter.
  // '1' trusts only Nginx — clients cannot spoof X-Forwarded-For.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // ── B7: Redis Socket.IO adapter ───────────────────────────────────────────
  // Must be registered BEFORE enableCors so Socket.IO inherits CORS config.
  // Gracefully falls back to in-memory adapter if @socket.io/redis-adapter
  // is not installed (dev) — install on VPS for PM2 cluster-safe operation:
  //   npm install @socket.io/redis-adapter
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.enableCors({
    origin:
      nodeEnv === 'production'
        ? ['https://api.emilestone.com']
        : true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: true,
  });

  // ── CRITICAL: Global API prefix — Flutter sends to /api/v1/* ─────────────
  app.setGlobalPrefix('api/v1');

  // ── Global validation pipe ────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      errorHttpStatusCode: 422,
    }),
  );

  // ── Phase B6: Bull Board queue dashboard ──────────────────────────────────
  await app.init();
  setupBullBoard(app);

  // ── Graceful shutdown (PM2 cluster-safe) ──────────────────────────────────
  app.enableShutdownHooks();

  // ── Start server ──────────────────────────────────────────────────────────
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`
╔════════════════════════════════════════════════════╗
║  Smart Meal & Attendance SaaS — Phase B7           ║
║  Server  : http://localhost:${port}/api/v1            ║
║  Health  : http://localhost:${port}/api/v1/health     ║
║  Queues  : http://localhost:${port}/queues             ║
║  WS      : ws://localhost:${port} (Socket.IO)         ║
╚════════════════════════════════════════════════════╝
  `);
}

bootstrap();
