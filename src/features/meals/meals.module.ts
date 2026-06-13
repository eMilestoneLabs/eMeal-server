import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';

// Meals feature
import { MealsController } from './meals.controller';
import { SchedulesController } from './schedules.controller';
import { MealsService } from './meals.service';
import { SchedulesService } from './schedules.service';
import { MealsRepository } from './repositories/meals.repository';
import { SchedulesRepository } from './repositories/schedules.repository';

// GroupsModule needed for GroupsRepository (org isolation + mealConfig verification)
import { GroupsModule } from '../groups/groups.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { StorageModule } from '../../storage/storage.module';

/**
 * MealsModule — Phase B3
 *
 * Provides:
 *   MealsController      → POST/GET/PATCH/DELETE /api/v1/meals
 *   SchedulesController  → POST/GET/PATCH/POST /api/v1/schedules
 *   MealsService         → Meal CRUD + reorder business logic
 *   SchedulesService     → Schedule CRUD + publish + clone business logic
 *   MealsRepository      → Prisma queries for Meal model (org-scoped)
 *   SchedulesRepository  → Prisma queries for MealSchedule + ScheduleEntry (org-scoped)
 *
 * Imports:
 *   GroupsModule — provides GroupsRepository (verify group belongs to org,
 *                  check mealsEnabled/weeklyMenuEnabled flags)
 *   PrismaModule — database access
 *   AuditModule  — fire-and-forget audit logging
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    GroupsModule, // for GroupsRepository access
    RealtimeModule,   // for 'REALTIME_GATEWAY' token (@Optional inject in services)
    StorageModule,    // B11: MinIO meal-image upload
  ],
  controllers: [MealsController, SchedulesController],
  providers: [
    MealsService,
    SchedulesService,
    MealsRepository,
    SchedulesRepository,
  ],
  exports: [
    MealsService,
    SchedulesService,
    MealsRepository,
    SchedulesRepository,
  ],
})
export class MealsModule {}
