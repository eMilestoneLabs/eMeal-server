import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditIntegrityController } from './audit-integrity.controller';

@Global()
@Module({
  controllers: [AuditIntegrityController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
