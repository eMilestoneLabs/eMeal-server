import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

// Config
import appConfig from '../config/app.config';
import jwtConfig from '../config/jwt.config';
import redisConfig from '../config/redis.config';
import authConfig from '../config/auth.config';

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
import { RealtimeModule } from '../realtime/realtime.module';
// Phase B5
import { EventsModule } from '../features/events/events.module';
import { DashboardModule } from '../features/dashboard/dashboard.module';
import { ExportsModule } from '../features/exports/exports.module';
import { ReportsModule } from '../features/reports/reports.module';
// Phase B6
import { QueueModule } from '../queue/queue.module';
import { WorkersModule } from '../workers/workers.module';

// App-level
import { HealthController } from './health.controller';

@Module({
  imports: [
    // Config — global, loaded first
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, jwtConfig, redisConfig, authConfig],
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
    // Phase B5
    EventsModule,
    DashboardModule,
    ExportsModule,
    ReportsModule,
    // Phase B6 — Queue infrastructure + background workers
    QueueModule,
    WorkersModule,
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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
