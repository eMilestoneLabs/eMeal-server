import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { GroupsModule } from '../groups/groups.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { CorrectionRequestsRepository } from './repositories/correction-requests.repository';

/**
 * CorrectionsModule — Module 33 Attendance Correction Requests (FR-ACR-*).
 *
 * Import chain:
 *   AttendanceModule → AttendanceService.applyConsentedChange (shared write
 *   path) + AttendanceRepository.findByKey
 *   GroupsModule     → MembersRepository (isActiveMember checks)
 *   RealtimeModule   → 'ATTENDANCE_GATEWAY' token (injected @Optional)
 *   NotificationsModule → best-effort push on request/decision (FR-ACR)
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    GroupsModule,
    AttendanceModule,
    RealtimeModule,
    NotificationsModule,
  ],
  controllers: [CorrectionsController],
  providers: [CorrectionsService, CorrectionRequestsRepository],
  exports: [CorrectionsService, CorrectionRequestsRepository],
})
export class CorrectionsModule {}
