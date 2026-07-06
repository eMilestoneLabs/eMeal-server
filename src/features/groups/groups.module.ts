import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupsRepository } from './repositories/groups.repository';
import { MembersRepository } from './repositories/members.repository';
import { UsersModule } from '../users/users.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { NoticesModule } from '../notices/notices.module';
import { NotificationsModule } from '../notifications/notifications.module';

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
  providers: [GroupsService, GroupsRepository, MembersRepository],
  exports: [GroupsService, GroupsRepository, MembersRepository],
})
export class GroupsModule {}
