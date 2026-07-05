import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../../audit/audit.module';
import { NoticesModule } from '../notices/notices.module';

import { VacationsController } from './vacations.controller';
import { VacationsService } from './vacations.service';
import { VacationRequestsRepository } from './repositories/vacation-requests.repository';

/**
 * VacationsModule — Issue 3 vacation approval workflow (self-contained).
 * #4: imports NoticesModule to raise an admin-bell alert on request submission.
 */
@Module({
  imports: [PrismaModule, AuditModule, NoticesModule],
  controllers: [VacationsController],
  providers: [VacationsService, VacationRequestsRepository],
  exports: [VacationsService, VacationRequestsRepository],
})
export class VacationsModule {}
