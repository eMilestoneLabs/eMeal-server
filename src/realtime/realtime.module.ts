import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AttendanceGateway } from './gateway/attendance.gateway';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { WsMetricsService } from './services/ws-metrics.service';
import { RealtimeEventsService } from './services/realtime-events.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

/**
 * RealtimeModule — B4 + B7 Socket.IO WebSocket infrastructure.
 *
 * Provides:
 *   AttendanceGateway     — Socket.IO gateway (connection lifecycle, room mgmt, emit helpers)
 *   WsJwtGuard            — JWT guard for WS connections and message handlers
 *   WsMetricsService      — connection / room / latency metrics
 *   RealtimeEventsService — typed event emitter for feature modules
 *
 * Tokens:
 *   ATTENDANCE_GATEWAY    — gateway alias (used by AttendanceService @Inject)
 *   REALTIME_GATEWAY      — RealtimeEventsService alias (used by other feature modules)
 *
 * Dependency order:
 *   AppModule imports RealtimeModule AFTER AttendanceModule to avoid circular deps.
 *   Feature services inject gateway via @Optional() @Inject('ATTENDANCE_GATEWAY').
 */
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: {
          expiresIn: config.get<string>('jwt.accessExpiresIn') ?? '15m',
        },
      }),
    }),
  ],
  providers: [
    // Infrastructure
    WsMetricsService,
    WsJwtGuard,

    // Gateway
    AttendanceGateway,

    // Token alias — AttendanceService injects via @Inject('ATTENDANCE_GATEWAY')
    {
      provide: 'ATTENDANCE_GATEWAY',
      useExisting: AttendanceGateway,
    },

    // RealtimeEventsService — unified typed emitter for all feature modules
    RealtimeEventsService,

    // Token alias — feature modules inject via @Inject('REALTIME_GATEWAY')
    {
      provide: 'REALTIME_GATEWAY',
      useExisting: RealtimeEventsService,
    },
  ],
  exports: [
    AttendanceGateway,
    WsJwtGuard,
    WsMetricsService,
    RealtimeEventsService,
    'ATTENDANCE_GATEWAY',
    'REALTIME_GATEWAY',
  ],
})
export class RealtimeModule {}
