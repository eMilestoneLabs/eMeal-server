import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupsRepository } from './repositories/groups.repository';
import { MembersRepository } from './repositories/members.repository';
import { UsersModule } from '../users/users.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { NoticesModule } from '../notices/notices.module';
import { NotificationsModule } from '../notifications/notifications.module';
// Live-Test-15 ISSUE-1: planner Auto-Draft on a Weekly ⇆ Day-Wise mode flip.
// Declared as a LOCAL provider (not via MealsModule) because MealsModule
// already imports GroupsModule — importing it back would make the two
// circular. The service depends only on PrismaService + AuditService +
// the optional realtime token, so it needs no meals wiring.
import { PlannerModeConversionService } from '../meals/services/planner-mode-conversion.service';
// Same reasoning as above: LOCAL provider, not via MealsModule (which already
// imports GroupsModule). SchedulesRepository depends only on PrismaService.
import { SchedulesRepository } from '../meals/repositories/schedules.repository';

@Module({
  imports: [
    UsersModule, // For UsersRepository (sync organizationId on join, permission checks)
    RealtimeModule,   // for 'REALTIME_GATEWAY' token (@Optional inject in GroupsService)
    // Module 02: in-app bell notices + best-effort FCM push for lifecycle
    // events (join request/approve/reject/block/unblock/remove/group-full).
    NoticesModule,
    NotificationsModule,
  ],
  controllers: [GroupsController],
  providers: [
    GroupsService,
    GroupsRepository,
    MembersRepository,
    PlannerModeConversionService,
    SchedulesRepository,
  ],
  exports: [GroupsService, GroupsRepository, MembersRepository],
})
export class GroupsModule {}
