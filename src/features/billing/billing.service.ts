import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { toUtcMidnight } from '../../common/utils/date.utils';
import { FinalizePeriodDto, ReopenPeriodDto } from './dto/billing-period.dto';

/**
 * BillingService — SRS FR-DISP-010 (Pass 7): billing period finalization &
 * controlled reopen (LOOP-014: statements can never change silently after
 * close).
 *
 * A 'finalized' BillingPeriod locks every attendance/billing write whose date
 * falls inside [periodStart, periodEnd] — the attendance write paths call
 * isDateFinalized() and reject with 423 PERIOD_FINALIZED. Reopening (reason
 * mandatory, audited) lifts the lock until an admin re-finalizes; the
 * finalize-time totalsSnapshot is kept immutable for reprint either way.
 *
 * Append-only monetary adjustments (FR-BILLX-030/031) are Module 25 work —
 * until then, post-lock corrections REQUIRE an explicit reopen, which is the
 * fail-safe direction (no change without an audited unlock).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Finalize (POST /billing/periods) ───────────────────────────────────────

  async finalizePeriod(
    adminId: string,
    organizationId: string,
    dto: FinalizePeriodDto,
    requestId?: string,
  ) {
    const start = toUtcMidnight(dto.periodStart);
    const end = toUtcMidnight(dto.periodEnd);
    if (end.getTime() < start.getTime()) {
      throw new BadRequestException({
        message: 'periodEnd must be on or after periodStart',
        errors: { periodEnd: 'Before periodStart' },
      });
    }
    const todayUtc = toUtcMidnight(new Date().toISOString().slice(0, 10));
    if (end.getTime() > todayUtc.getTime()) {
      throw new BadRequestException({
        message: 'Cannot finalize a period that extends into the future',
        errors: { periodEnd: 'Must be today or earlier' },
      });
    }

    const group = await this.prisma.group.findFirst({
      where: { id: dto.groupId, organizationId },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found');

    // No overlapping FINALIZED period (reopened ones may be re-finalized).
    const overlap = await this.prisma.billingPeriod.findFirst({
      where: {
        organizationId,
        groupId: dto.groupId,
        status: 'finalized',
        periodStart: { lte: end },
        periodEnd: { gte: start },
      },
      select: { id: true, periodStart: true, periodEnd: true },
    });
    if (overlap) {
      throw new UnprocessableEntityException({
        message: 'An overlapping finalized period already exists',
        code: 'PERIOD_OVERLAP',
        errors: {
          periodStart: `Overlaps period ${overlap.periodStart
            .toISOString()
            .slice(0, 10)} – ${overlap.periodEnd.toISOString().slice(0, 10)}`,
        },
      });
    }

    const totalsSnapshot = await this.buildTotalsSnapshot(
      organizationId,
      dto.groupId,
      start,
      end,
    );

    const period = await this.prisma.billingPeriod.create({
      data: {
        organizationId,
        groupId: dto.groupId,
        periodStart: start,
        periodEnd: end,
        status: 'finalized',
        finalizedBy: adminId,
        totalsSnapshot,
      },
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: period.id,
      targetType: 'BillingPeriod',
      action: 'create',
      metadata: {
        groupId: dto.groupId,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
      },
      requestId,
    });

    return this.toResponse(period);
  }

  // ── List (GET /billing/periods) ────────────────────────────────────────────

  async listPeriods(organizationId: string, groupId?: string) {
    const rows = await this.prisma.billingPeriod.findMany({
      where: { organizationId, ...(groupId ? { groupId } : {}) },
      orderBy: { periodStart: 'desc' },
      take: 50,
    });
    return { data: rows.map((r) => this.toResponse(r)) };
  }

  // ── Reopen (POST /billing/periods/:id/reopen) ──────────────────────────────

  async reopenPeriod(
    adminId: string,
    organizationId: string,
    id: string,
    dto: ReopenPeriodDto,
    requestId?: string,
  ) {
    const period = await this.loadPeriod(id, organizationId);
    if (period.status !== 'finalized') {
      throw new BadRequestException({
        message: 'Only a finalized period can be reopened',
        errors: { status: `Period is ${period.status}` },
      });
    }

    const updated = await this.prisma.billingPeriod.update({
      where: { id },
      data: {
        status: 'reopened',
        reopenedBy: adminId,
        reopenedAt: new Date(),
        reopenReason: dto.reason,
      },
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'BillingPeriod',
      action: 'update',
      metadata: { decision: 'reopened', reason: dto.reason },
      requestId,
    });

    return this.toResponse(updated);
  }

  // ── Re-finalize (POST /billing/periods/:id/finalize) ───────────────────────

  async refinalizePeriod(
    adminId: string,
    organizationId: string,
    id: string,
    requestId?: string,
  ) {
    const period = await this.loadPeriod(id, organizationId);
    if (period.status !== 'reopened') {
      throw new BadRequestException({
        message: 'Only a reopened period can be re-finalized',
        errors: { status: `Period is ${period.status}` },
      });
    }

    // Fresh snapshot: the reopen existed precisely to allow consented
    // corrections; the re-lock captures the corrected totals. The original
    // finalize-time snapshot remains in the audit trail (append-only).
    const totalsSnapshot = await this.buildTotalsSnapshot(
      organizationId,
      period.groupId,
      period.periodStart,
      period.periodEnd,
    );

    const updated = await this.prisma.billingPeriod.update({
      where: { id },
      data: {
        status: 'finalized',
        finalizedBy: adminId,
        finalizedAt: new Date(),
        totalsSnapshot,
      },
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'BillingPeriod',
      action: 'update',
      metadata: { decision: 'refinalized', previousSnapshot: period.totalsSnapshot },
      requestId,
    });

    return this.toResponse(updated);
  }

  // ── Lock check (used by attendance write paths) ────────────────────────────

  /**
   * True when [dateUtc] falls inside a FINALIZED period for the group.
   * One indexed query on the write path — reads are never affected.
   */
  async isDateFinalized(
    organizationId: string,
    groupId: string,
    dateUtc: Date,
  ): Promise<{ locked: boolean; periodEnd?: string }> {
    const hit = await this.prisma.billingPeriod.findFirst({
      where: {
        organizationId,
        groupId,
        status: 'finalized',
        periodStart: { lte: dateUtc },
        periodEnd: { gte: dateUtc },
      },
      select: { periodEnd: true },
    });
    return hit
      ? { locked: true, periodEnd: hit.periodEnd.toISOString().slice(0, 10) }
      : { locked: false };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async loadPeriod(id: string, organizationId: string) {
    const period = await this.prisma.billingPeriod.findFirst({
      where: { id, organizationId },
    });
    if (!period) {
      throw new NotFoundException({
        message: 'Billing period not found',
        errors: { id: 'Does not exist in your organization' },
      });
    }
    return period;
  }

  /** Immutable reprint snapshot: per-member present count + billed total. */
  private async buildTotalsSnapshot(
    organizationId: string,
    groupId: string,
    start: Date,
    end: Date,
  ) {
    const perMember = await this.prisma.attendanceRecord.groupBy({
      by: ['userId'],
      where: {
        organizationId,
        groupId,
        attendanceDate: { gte: start, lte: end },
        status: 'present',
      },
      _count: { _all: true },
      _sum: { price: true },
    });
    return {
      capturedAt: new Date().toISOString(),
      members: perMember.map((m) => ({
        userId: m.userId,
        presentCount: m._count._all,
        totalAmount: m._sum.price ?? 0,
      })),
    };
  }

  private toResponse(p: {
    id: string;
    groupId: string;
    periodStart: Date;
    periodEnd: Date;
    status: string;
    finalizedBy: string;
    finalizedAt: Date;
    reopenedBy: string | null;
    reopenedAt: Date | null;
    reopenReason: string | null;
    totalsSnapshot: unknown;
    createdAt: Date;
  }) {
    return {
      id: p.id,
      groupId: p.groupId,
      periodStart: p.periodStart.toISOString().slice(0, 10),
      periodEnd: p.periodEnd.toISOString().slice(0, 10),
      status: p.status,
      finalizedBy: p.finalizedBy,
      finalizedAt: p.finalizedAt.toISOString(),
      reopenedBy: p.reopenedBy,
      reopenedAt: p.reopenedAt?.toISOString() ?? null,
      reopenReason: p.reopenReason,
      totalsSnapshot: p.totalsSnapshot ?? null,
      createdAt: p.createdAt.toISOString(),
    };
  }
}
