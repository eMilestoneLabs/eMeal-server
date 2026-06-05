import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupsRepository } from './repositories/groups.repository';
import { MembersRepository } from './repositories/members.repository';
import { UsersModule } from '../users/users.module';
import { RealtimeModule } from '../../realtime/realtime.module';

@Module({
  imports: [
    UsersModule, // For UsersRepository (sync organizationId on join, permission checks)
    RealtimeModule,   // for 'REALTIME_GATEWAY' token (@Optional inject in GroupsService)
  ],
  controllers: [GroupsController],
  providers: [GroupsService, GroupsRepository, MembersRepository],
  exports: [GroupsService, GroupsRepository, MembersRepository],
})
export class GroupsModule {}
