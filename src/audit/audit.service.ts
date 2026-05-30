import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface CreateAuditLogDto {
  organizationId?: string;
  actorId?: string;
  targetId?: string;
  targetType: string;
  action: AuditAction;
  metadata?: Record<string, unknown>;
  requestId?: string;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(dto: CreateAuditLogDto): Promise<void> {
    // Fire-and-forget — do not block the request on audit logging
    this.prisma.auditLog
      .create({
        data: {
          organizationId: dto.organizationId,
          actorId: dto.actorId,
          targetId: dto.targetId,
          targetType: dto.targetType,
          action: dto.action,
          metadata: dto.metadata as any,
          requestId: dto.requestId,
          ipAddress: dto.ipAddress,
        },
      })
      .catch(() => {
        // Audit failures must never crash the main request
      });
  }
}
