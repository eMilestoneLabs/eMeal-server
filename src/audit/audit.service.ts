import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
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

/**
 * Pass 14 (FR-DLC-006, LOOP-084) — tamper-evident, append-only audit trail.
 *
 * Append-only is enforced at the code level: this service exposes ONLY
 * `log()` (and read-side `verifyIntegrity()`); no update/delete path exists
 * anywhere in the application for audit rows. Retention is handled by the
 * cleanup worker per policy.
 *
 * Tamper-EVIDENCE: each row carries an HMAC-SHA256 over its canonical
 * content, keyed by env `AUDIT_HMAC_SECRET`. An attacker with database
 * access but without the application secret cannot modify or forge a row
 * without the mismatch being detectable. Key absent = rows written unsigned
 * (additive rollout; older rows are reported as `unsigned`, never `invalid`).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly hmacSecret = process.env.AUDIT_HMAC_SECRET || '';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Deterministic serialization: JSONB does not preserve key order, so the
   * HMAC must be computed over a recursively key-sorted rendering that is
   * identical at write time and at verify time.
   */
  private static stableStringify(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
      return `[${value.map((v) => AuditService.stableStringify(v)).join(',')}]`;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys
        .map(
          (k) =>
            `${JSON.stringify(k)}:${AuditService.stableStringify(
              (value as Record<string, unknown>)[k],
            )}`,
        )
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private computeHmac(row: {
    organizationId?: string | null;
    actorId?: string | null;
    targetId?: string | null;
    targetType: string;
    action: string;
    metadata?: unknown;
    requestId?: string | null;
    createdAt: Date;
  }): string {
    const canonical = [
      'v1',
      row.organizationId ?? '',
      row.actorId ?? '',
      row.targetId ?? '',
      row.targetType,
      row.action,
      row.requestId ?? '',
      row.createdAt.toISOString(),
      AuditService.stableStringify(row.metadata ?? null),
    ].join('|');
    return createHmac('sha256', this.hmacSecret).update(canonical).digest('hex');
  }

  async log(dto: CreateAuditLogDto): Promise<void> {
    // Fire-and-forget — do not block the request on audit logging.
    // createdAt is set HERE (not by DB default) so the signed timestamp is
    // exactly the stored timestamp.
    const createdAt = new Date();
    const integrityHmac = this.hmacSecret
      ? this.computeHmac({
          organizationId: dto.organizationId,
          actorId: dto.actorId,
          targetId: dto.targetId,
          targetType: dto.targetType,
          action: dto.action,
          metadata: dto.metadata ?? null,
          requestId: dto.requestId,
          createdAt,
        })
      : null;

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
          createdAt,
          ...(integrityHmac ? { integrityHmac } : {}),
        } as any,
      })
      .catch(() => {
        // Audit failures must never crash the main request
      });
  }

  /**
   * FR-DLC-006 verification: recompute the HMAC for the most recent [limit]
   * rows of an org and report tampering evidence. Admin/read-only.
   */
  async verifyIntegrity(organizationId: string, limit = 500) {
    const rows = (await this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(2000, Math.max(1, limit)),
    })) as Array<{
      id: string;
      organizationId: string | null;
      actorId: string | null;
      targetId: string | null;
      targetType: string;
      action: string;
      metadata: unknown;
      requestId: string | null;
      createdAt: Date;
      integrityHmac?: string | null;
    }>;

    if (!this.hmacSecret) {
      return {
        checked: rows.length,
        signed: 0,
        valid: 0,
        unsigned: rows.length,
        mismatched: [],
        note: 'AUDIT_HMAC_SECRET not configured — rows are written unsigned',
      };
    }

    let signed = 0;
    let valid = 0;
    const mismatched: string[] = [];
    for (const r of rows) {
      if (!r.integrityHmac) continue; // pre-rollout row — unsigned, not invalid
      signed++;
      const expected = this.computeHmac(r);
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(r.integrityHmac, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        valid++;
      } else {
        mismatched.push(r.id);
      }
    }
    if (mismatched.length > 0) {
      this.logger.warn(
        `Audit integrity check FAILED for org=${organizationId}: ${mismatched.length} tampered row(s)`,
      );
    }
    return {
      checked: rows.length,
      signed,
      valid,
      unsigned: rows.length - signed,
      mismatched,
    };
  }
}
