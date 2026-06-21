import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';

import { VacationsController } from './vacations.controller';
import { VacationsService } from './vacations.service';
import { VacationRequestsRepository } from './repositories/vacation-requests.repository';

/**
 * VacationsModule — Issue 3 vacation approval workflow (self-contained).
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [VacationsController],
  providers: [VacationsService, VacationRequestsRepository],
  exports: [VacationsService, VacationRequestsRepository],
})
export class VacationsModule {}
