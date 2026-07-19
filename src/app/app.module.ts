import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

// Config
import appConfig from '../config/app.config';
import jwtConfig from '../config/jwt.config';
import redisConfig from '../config/redis.config';
import authConfig from '../config/auth.config';
import correctionsConfig from '../config/corrections.config';
import preferencesConfig from '../config/preferences.config';
import attendanceConfig from '../config/attendance.config';
import groupsConfig from '../config/groups.config';
import mealsConfig from '../config/meals.config';
import retentionConfig from '../config/retention.config';
import auditConfig from '../config/audit.config';

// Infrastructure
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { AuditModule } from '../audit/audit.module';

// Common
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { LoggingInterceptor } from '../common/interceptors/logging.interceptor';
import { RequestIdMiddleware } from '../common/middleware/request-id.middleware';

// Features
import { AuthModule } from '../features/auth/auth.module';
import { UsersModule } from '../features/users/users.module';
import { NotificationsModule } from '../features/notifications/notifications.module';
import { NoticesModule } from '../features/notices/notices.module';
import { VacationsModule } from '../features/vacations/vacations.module';
import { OrganizationsModule } from '../features/organizations/organizations.module';
import { GroupsModule } from '../features/groups/groups.module';
import { MealsModule } from '../features/meals/meals.module';
import { AttendanceModule } from '../features/attendance/attendance.module';
import { CorrectionsModule } from '../features/corrections/corrections.module';
import { BillingModule } from '../features/billing/billing.module';
import { GuestsModule } from '../features/guests/guests.module';
import { PreferencesModule } from '../features/preferences/preferences.module';
import { RealtimeModule } from '../realtime/realtime.module';
// Phase B5
import { EventsModule } from '../features/events/events.module';
import { DashboardModule } from '../features/dashboard/dashboard.module';
import { OverviewModule } from '../features/overview/overview.module';
import { ExportsModule } from '../features/exports/exports.module';
import { ReportsModule } from '../features/reports/reports.module';
// SRS Module 03 RET-001..015 — rolling 3-month retention & Data Archives
import { RetentionModule } from '../features/retention/retention.module';
// Phase B6
import { QueueModule } from '../queue/queue.module';
import { WorkersModule } from '../workers/workers.module';
// Observability — client-side crash telemetry ingestion (additive, no DB)
import { TelemetryModule } from '../features/telemetry/telemetry.module';

// App-level
import { HealthController } from './health.controller';
import { WarmupService } from './warmup.service';

// ── Web/worker tier split (2026-07-19) ───────────────────────────────────────
// Benchmark forensics: BullMQ consumers + the repeatable sweep scheduler ran
// inside every HTTP-serving PM2 worker, so a sweep firing mid-request blocked
// that worker's event loop for 50–400ms — the measured rotating p95 outliers
// (a DIFFERENT endpoint set slow on every audit run while mins never moved).
// QUEUE_ROLE gates the tier: 'web' = HTTP only (no job processors), 'worker'
// = the dedicated emeal-worker PM2 process that owns all job processing, any
// other value (default 'all') = legacy single-tier behavior — so a deploy
// without the env set, and every existing test, behaves exactly as before.
// Realtime emits from worker-run jobs reach web-connected sockets through the
// Socket.IO Redis adapter (already mandatory across the PM2 cluster).
// Fail-safe direction: only the exact value 'web' sheds processors — a typo'd
// role still processes jobs rather than silently letting queues pile up.
const QUEUE_ROLE = process.env.QUEUE_ROLE ?? 'all';

@Module({
  imports: [
    // Config — global, loaded first
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        jwtConfig,
        redisConfig,
        authConfig,
        correctionsConfig,
        preferencesConfig,
        attendanceConfig,
        groupsConfig,
        mealsConfig,
        retentionConfig,
        auditConfig,
      ],
      envFilePath: ['.env'],
    }),

    // Rate limiting — global
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: parseInt(process.env.THROTTLE_TTL ?? '60000', 10),
        limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
      },
    ]),

    // Infrastructure (global providers)
    PrismaModule,
    RedisModule,
    AuditModule,

    // Feature modules — Phase B1
    AuthModule,
    UsersModule,
    NotificationsModule,
    // Phase B2
    OrganizationsModule,
    GroupsModule,
    // Phase B3
    MealsModule,
    NoticesModule,
    VacationsModule,
    // Phase B4
    AttendanceModule,
    RealtimeModule,
    // Module 33 — Attendance Correction Requests (consent workflow)
    CorrectionsModule,
    // Pass 7 — FR-DISP-010 billing period finalization & controlled reopen
    BillingModule,
    // Pass 8 — Module 22 Member-Hosted Guests (+N)
    GuestsModule,
    // Module 36 — Multi-dimensional preference groups (FR-PG-*)
    PreferencesModule,
    // Phase B5
    EventsModule,
    DashboardModule,
    OverviewModule,
    ExportsModule,
    ReportsModule,
    // SRS Module 03 — retention archives (Reports → Data Archives)
    RetentionModule,
    // Phase B6 — Queue infrastructure + background workers.
    // QueueModule (producers — services enqueue jobs) loads on EVERY tier;
    // WorkersModule (consumers + repeatable scheduler) is shed on 'web' so
    // request event loops never execute background jobs.
    QueueModule,
    ...(QUEUE_ROLE === 'web' ? [] : [WorkersModule]),
    // Observability — Flutter crash-report sink (structured logs → Loki/Grafana)
    TelemetryModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global exception filter — formats all errors to frontend contract
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    // Global JWT auth guard — all routes require auth unless @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global throttler guard
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global request logging
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // Post-reload cold-start eliminator (fire-and-forget on bootstrap)
    WarmupService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
