import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { AttendanceRepository } from './repositories/attendance.repository';
import { GroupsModule } from '../groups/groups.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { AuditModule } from '../../audit/audit.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { PreferencesModule } from '../preferences/preferences.module';
import { BillingModule } from '../billing/billing.module';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * AttendanceModule — Phase B4 attendance system.
 *
 * Import chain:
 *   GroupsModule → MembersRepository (isActiveMember check)
 *   RealtimeModule → 'ATTENDANCE_GATEWAY' token (injected @Optional in service)
 *
 * Circular dependency prevention:
 *   AttendanceService @Inject('ATTENDANCE_GATEWAY') @Optional()
 *   → token provided by RealtimeModule which does NOT import AttendanceModule
 */
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuditModule,
    GroupsModule,       // provides MembersRepository
    RealtimeModule,     // provides 'ATTENDANCE_GATEWAY' token
    PreferencesModule,  // Module 36 — selection validation + pricing (FR-PG-031/040)
    BillingModule,      // Pass 7 — FR-DISP-010 period-lock guard (prisma-only, no cycle)
    NotificationsModule, // Pass 7 — FR-TRUST-011 member notify on non-self changes
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService, AttendanceRepository],
  exports: [AttendanceService, AttendanceRepository],
})
export class AttendanceModule {}
