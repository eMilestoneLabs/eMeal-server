import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app/app.module';
import { setupBullBoard } from './app/bull-board.setup';
import { RedisIoAdapter } from './realtime/adapters/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
    bufferLogs: false,
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
