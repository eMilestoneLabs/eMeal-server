/**
 * queue.module.ts — B6 Phase
 *
 * Provides BullMQ Queue instances for all 5 queues.
 *
 * Architecture:
 *   - Uses ioredis directly (NOT the app's RedisService).
 *     BullMQ requires its own dedicated Redis connection — sharing
 *     the application connection leads to blocking command conflicts.
 *   - Connection is created once and shared across all Queue instances
 *     via the IORedis connection option (BullMQ reuses the connection internally).
 *   - Queues are exported so services/workers can inject them with @InjectQueue.
 *
 * Queue registration pattern:
 *   BullModule.registerQueue({ name: QUEUE_NAMES.X }) registers the queue
 *   and makes InjectQueue(QUEUE_NAMES.X) available in the module's context.
 */

import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from './constants/queue.constants';
import { QueueService } from './queue.service';

@Global()
@Module({
  imports: [
    // Configure BullMQ root connection — dedicated Redis connection for queues
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host') ?? 'localhost',
          port: config.get<number>('redis.port') ?? 6379,
          password: config.get<string>('redis.password'),
          // BullMQ-specific: max retries, reconnect strategy
          maxRetriesPerRequest: null,  // BullMQ requires null for blocking commands
          enableReadyCheck: false,
          retryStrategy: (times: number) => Math.min(times * 200, 5000),
        },
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
      inject: [ConfigService],
    }),

    // Register all 5 queues
    BullModule.registerQueue(
      { name: QUEUE_NAMES.NOTIFICATION },
      { name: QUEUE_NAMES.ATTENDANCE_REMINDER },
      { name: QUEUE_NAMES.ANALYTICS },
      { name: QUEUE_NAMES.EXPORT },
      { name: QUEUE_NAMES.CLEANUP },
    ),
  ],

  providers: [QueueService],

  exports: [
    // Export BullModule so workers can inject queues
    BullModule,
    QueueService,
  ],
})
export class QueueModule {}
