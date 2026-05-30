/**
 * bull-board.setup.ts — B6 Phase
 *
 * Mounts Bull Board queue dashboard at /api/v1/queues.
 *
 * Access: admin-only. Protected by a simple API key check via
 * BULL_BOARD_SECRET env var. Production: place behind Nginx basic auth.
 *
 * Bull Board shows:
 *   - All 5 queues (notification, attendance-reminder, analytics, export, cleanup)
 *   - Waiting / active / completed / failed / delayed counts per queue
 *   - Failed job details (payload, error, attempt count)
 *   - Ability to retry or discard failed jobs manually
 *
 * Usage:
 *   Call setupBullBoard(app) in main.ts AFTER app.setGlobalPrefix().
 *   Bull Board mounts its own Express router — it bypasses NestJS routing.
 *
 * MVP: Bull Board is @bull-board/express adapter (no NestJS middleware overhead).
 */

import { INestApplication, Logger } from '@nestjs/common';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/constants/queue.constants';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

const logger = new Logger('BullBoard');

/**
 * Sets up Bull Board at /queues on the Express instance.
 * Call this in main.ts AFTER app.init().
 */
export function setupBullBoard(app: INestApplication): void {
  const configService = app.get(ConfigService);
  const redisHost = configService.get<string>('redis.host') ?? 'localhost';
  const redisPort = configService.get<number>('redis.port') ?? 6379;
  const redisPassword = configService.get<string>('redis.password');
  const secret = configService.get<string>('BULL_BOARD_SECRET') ?? process.env.BULL_BOARD_SECRET;

  // Create BullMQ Queue instances for the board (read-only observers)
  const connection = {
    host: redisHost,
    port: redisPort,
    password: redisPassword,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  const queues = [
    QUEUE_NAMES.NOTIFICATION,
    QUEUE_NAMES.ATTENDANCE_REMINDER,
    QUEUE_NAMES.ANALYTICS,
    QUEUE_NAMES.EXPORT,
    QUEUE_NAMES.CLEANUP,
  ].map((name) => new BullMQAdapter(new Queue(name, { connection })));

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/queues');

  createBullBoard({
    queues: queues as any,
    serverAdapter,
  });

  const httpAdapter = app.getHttpAdapter().getInstance();

  // Admin-only middleware: require BULL_BOARD_SECRET header
  httpAdapter.use(
    '/queues',
    (req: Request, res: Response, next: NextFunction) => {
      if (!secret) {
        // No secret configured — block all access in production
        const nodeEnv = process.env.NODE_ENV ?? 'development';
        if (nodeEnv !== 'development') {
          res.status(403).json({
            message: 'Queue dashboard disabled — BULL_BOARD_SECRET not configured',
            statusCode: 403,
          });
          return;
        }
      } else {
        const provided = req.headers['x-bull-board-secret'] as string;
        if (provided !== secret) {
          res.status(401).json({
            message: 'Unauthorized — invalid queue dashboard secret',
            statusCode: 401,
          });
          return;
        }
      }
      next();
    },
    serverAdapter.getRouter(),
  );

  logger.log('Bull Board mounted at /queues (admin access only)');
}
