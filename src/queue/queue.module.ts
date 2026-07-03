/**
 * queue.module.ts — B6 Phase
 *
 * Provides BullMQ Queue instances for all 5 queues.
 * Also registers QueueMetricsController (GET /admin/queues/stats).
 */

import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from './constants/queue.constants';
import { QueueService } from './queue.service';
import { QueueMetricsController } from './queue-metrics.controller';

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
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: (times: number) => Math.min(times * 200, 5000),
        },
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
      inject: [ConfigService],
    }),

    // Register all 7 queues
    BullModule.registerQueue(
      { name: QUEUE_NAMES.NOTIFICATION },
      { name: QUEUE_NAMES.ATTENDANCE_REMINDER },
      { name: QUEUE_NAMES.ANALYTICS },
      { name: QUEUE_NAMES.EXPORT },
      { name: QUEUE_NAMES.CLEANUP },
      { name: QUEUE_NAMES.SCHEDULE_PUBLISH },
      { name: QUEUE_NAMES.SYSTEM_DEFAULT },
    ),
  ],

  controllers: [QueueMetricsController],   // B6 gap: GET /admin/queues/stats
  providers: [QueueService],

  exports: [
    BullModule,
    QueueService,
  ],
})
export class QueueModule {}
