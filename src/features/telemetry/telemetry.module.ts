import { Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

/**
 * TelemetryModule — client-side (Flutter) crash-report ingestion.
 *
 * Fully self-contained and additive: no Prisma, no Redis, no queue, no realtime
 * dependency. It only turns app-reported uncaught errors into structured log
 * lines that the existing PM2 → promtail → Loki → Grafana pipeline already ships,
 * closing the "crash telemetry: flag present, no reporter wired" gap without a
 * third-party SaaS (Sentry) or any new infrastructure.
 */
@Module({
  controllers: [TelemetryController],
  providers: [TelemetryService],
})
export class TelemetryModule {}
