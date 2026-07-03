import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { RealtimeModule } from '../../realtime/realtime.module';

import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';
import { PreferenceGroupsRepository } from './repositories/preference-groups.repository';

/**
 * PreferencesModule — Module 36 multi-dimensional preference groups (FR-PG-*).
 *
 * Exports PreferencesService so AttendanceModule (selection validation +
 * pricing) and MealsModule (effective-group embedding) reuse ONE resolver —
 * no duplicated business logic (DRY).
 */
@Module({
  imports: [PrismaModule, AuditModule, RealtimeModule],
  controllers: [PreferencesController],
  providers: [PreferencesService, PreferenceGroupsRepository],
  exports: [PreferencesService, PreferenceGroupsRepository],
})
export class PreferencesModule {}
