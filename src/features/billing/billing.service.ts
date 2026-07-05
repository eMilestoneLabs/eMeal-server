import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { RedisService } from '../../redis/redis.service';
import { QueueService } from '../../queue/queue.service';
import {
  toUtcMidnight,
  getTodayInTimezone,
} from '../../common/utils/date.utils';
import { FinalizePeriodDto, ReopenPeriodDto } from './dto/billing-period.dto';
import {
  CreateAdjustmentDto,
  QueryAdjustmentsDto,
} from './dto/billing-adjustment.dto';

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
    // Pass 12 — optional so existing TestingModules keep working unchanged.
    // GOTCHA (Pass 7): `Class | null` erases design:paramtypes — the explicit
    // @Inject token is mandatory or Nest silently injects undefined.
    @Optional()
    @Inject(RedisService)
    private readonly redis: RedisService | null = null,
    @Optional()
    @Inject(QueueService)
    private readonly queue: QueueService | null = null,
  ) {}

  // ── Pass 12 (FR-BILLX-050) — billing read-cache version ────────────────────
  //
  // O(1) invalidation without SCAN: readers embed the group's version in the
  // cache key; any billing-relevant write bumps the version, orphaning every
  // cached range at once (orphans expire via TTL).

  async bumpBillingVersion(groupId: string): Promise<void> {
    try {
      await this.redis?.set(`bill:ver:${groupId}`, Date.now().toString());
    } catch {
      /* cache versioning is best-effort */
    }
  }

  async getBillingVersion(groupId: string): Promise<string> {
    try {
      return (await this.redis?.get(`bill:ver:${groupId}`)) ?? '0';
    } catch {
      return '0';
    }
  }

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

    const group = await this.prisma.group.findFirst({
      where: { id: dto.groupId, organizationId },
      select: { id: true, organization: { select: { timezone: true } } },
    });
    if (!group) throw new NotFoundException('Group not found');

    // "Future" is relative to the ORG's calendar day, not the server's UTC
    // day. Computing today in UTC wrongly rejected a period ending today when
    // an admin in a positive-offset zone (e.g. IST) finalized before the UTC
    // date rolled over — the server was still on "yesterday". (Issue 4)
    const tz = group.organization?.timezone ?? 'Asia/Kolkata';
    const todayUtc = toUtcMidnight(getTodayInTimezone(tz));
    if (end.getTime() > todayUtc.getTime()) {
      throw new BadRequestException({
        message: 'Cannot finalize a period that extends into the future',
        errors: { periodEnd: 'Must be today or earlier' },
      });
    }

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

  // ── Pass 12 (FR-BILLX-030/031/033, LOOP-010/004, GAP-103) — adjustments ───
  //
  // Append-only ledger: every manual bill correction is a NEW immutable row;
  // price snapshots are never edited. credit/refund decrease the bill freely;
  // a DEBIT (increase) obeys consent asymmetry (FR-FAIR-001) — it must
  // reference an APPROVED correction request for the same member.

  async createAdjustment(
    adminId: string,
    organizationId: string,
    dto: CreateAdjustmentDto,
    requestId?: string,
  ) {
    const group = await this.prisma.group.findFirst({
      where: { id: dto.groupId, organizationId },
      select: {
        id: true,
        organization: { select: { timezone: true } },
      },
    });
    if (!group) throw new NotFoundException('Group not found');

    const membership = await this.prisma.groupMember.findFirst({
      where: { groupId: dto.groupId, userId: dto.userId },
      select: { userId: true },
    });
    if (!membership) {
      throw new NotFoundException({
        message: 'Member not found in this group',
        errors: { userId: 'No membership in the target group' },
      });
    }

    // FR-FAIR-001 (LOOP-010): debits require member-consent proof.
    if (dto.type === 'debit') {
      if (!dto.refRequestId) {
        throw new ForbiddenException({
          message:
            'A debit must reference an approved correction request from the member',
          code: 'CONSENT_REQUIRED',
          errors: {
            refRequestId:
              'Liability can only increase through the member-consent path',
          },
        });
      }
      const acr = await (this.prisma as any).attendanceCorrectionRequest.findFirst({
        where: {
          id: dto.refRequestId,
          organizationId,
          userId: dto.userId,
          status: 'approved',
        },
        select: { id: true },
      });
      if (!acr) {
        throw new ForbiddenException({
          message:
            'The referenced correction request is not an approved request of this member',
          code: 'CONSENT_REQUIRED',
          errors: { refRequestId: 'Must be an APPROVED request of the same member' },
        });
      }
    }

    // Business date (org tz today by default). FR-BILLX-051: entries never
    // post INTO a finalized period — late corrections land in the open one.
    const tz = group.organization?.timezone ?? 'Asia/Kolkata';
    const entryDateStr = dto.entryDate
      ? dto.entryDate.slice(0, 10)
      : getTodayInTimezone(tz);
    const entryDate = toUtcMidnight(entryDateStr);
    const lock = await this.isDateFinalized(organizationId, dto.groupId, entryDate);
    if (lock.locked) {
      throw new UnprocessableEntityException({
        message:
          'This date lies in a finalized billing period — post the adjustment to an open date',
        code: 'PERIOD_FINALIZED',
        errors: { entryDate: `Period finalized through ${lock.periodEnd}` },
      });
    }

    const entry = await (this.prisma as any).billingLedgerEntry.create({
      data: {
        organizationId,
        groupId: dto.groupId,
        userId: dto.userId,
        entryDate,
        type: dto.type,
        amount: dto.amount,
        reason: dto.reason,
        refRecordId: dto.refRecordId ?? null,
        refGuestId: dto.refGuestId ?? null,
        refRequestId: dto.refRequestId ?? null,
        createdBy: adminId,
      },
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: entry.id,
      targetType: 'BillingLedgerEntry',
      action: 'create',
      metadata: {
        groupId: dto.groupId,
        userId: dto.userId,
        type: dto.type,
        amount: dto.amount,
        reason: dto.reason,
        ...(dto.refRequestId ? { refRequestId: dto.refRequestId } : {}),
      },
      requestId,
    });

    await this.bumpBillingVersion(dto.groupId);

    // Transparency (LOOP-035): the member always learns about bill changes.
    void this.prisma.user
      .findUnique({ where: { id: dto.userId }, select: { fcmToken: true } })
      .then((u) =>
        u?.fcmToken && this.queue
          ? this.queue.enqueueBatchPush({
              organizationId,
              recipients: [{ userId: dto.userId, fcmToken: u.fcmToken }],
              title:
                dto.type === 'debit'
                  ? 'A charge was added to your bill'
                  : 'A credit was applied to your bill',
              body: `${dto.type === 'debit' ? '+' : '−'}₹${(dto.amount / 100).toFixed(2)} — ${dto.reason}`,
              // Registered frontend path (Issue 6: '/billing' 404'd in-app).
              route: '/student/billing',
              data: { type: 'billing_adjustment', entryId: entry.id },
            })
          : undefined,
      )
      .catch((err) =>
        this.logger.warn(`adjustment push failed: ${(err as Error).message}`),
      );

    return this.adjustmentToResponse(entry);
  }

  async listAdjustments(organizationId: string, query: QueryAdjustmentsDto) {
    const page = query.page ?? 1;
    const limit = Math.min(100, query.limit ?? 20);
    const where = {
      organizationId,
      groupId: query.groupId,
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.fromDate || query.toDate
        ? {
            entryDate: {
              ...(query.fromDate ? { gte: toUtcMidnight(query.fromDate.slice(0, 10)) } : {}),
              ...(query.toDate ? { lte: toUtcMidnight(query.toDate.slice(0, 10)) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      (this.prisma as any).billingLedgerEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      (this.prisma as any).billingLedgerEntry.count({ where }),
    ]);
    return {
      data: rows.map((r: any) => this.adjustmentToResponse(r)),
      total,
      page,
      limit,
    };
  }

  /**
   * Signed adjustment sums per member for a group+range — one groupBy (grouped
   * by type). Sign convention: debit positive (increases the bill),
   * credit/refund negative.
   *
   * UNIT BOUNDARY (Issue 1/2): ledger rows are stored in paise (minor units),
   * but the billing engine — meal/guest price snapshots, revenue, member bills
   * — works in whole ₹. This is the single point where the ledger crosses into
   * that engine, so it converts paise → ₹ here. Returning paise made a ₹7,000
   * refund read as −₹7,00,000 once summed into a ₹ bill. Real corrections are
   * whole-rupee (admin types ₹, the client ×100s), so the division is exact;
   * the round only guards a hand-crafted sub-rupee entry.
   */
  async sumAdjustmentsByUser(
    organizationId: string,
    groupId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<Map<string, number>> {
    const rows: Array<{ userId: string; type: string; _sum: { amount: number | null } }> =
      await (this.prisma as any).billingLedgerEntry.groupBy({
        by: ['userId', 'type'],
        where: {
          organizationId,
          groupId,
          entryDate: { gte: fromDate, lte: toDate },
        },
        _sum: { amount: true },
      });
    // Accumulate in paise first, convert once per member — so multi-entry
    // sums round on the total, never per entry.
    const paiseByUser = new Map<string, number>();
    for (const r of rows) {
      const signed = (r._sum.amount ?? 0) * (r.type === 'debit' ? 1 : -1);
      paiseByUser.set(r.userId, (paiseByUser.get(r.userId) ?? 0) + signed);
    }
    const byUser = new Map<string, number>();
    for (const [userId, paise] of paiseByUser) {
      byUser.set(userId, Math.round(paise / 100));
    }
    return byUser;
  }

  /**
   * Pass 12 (FR-BILLX-020/041): the group's current billing period computed
   * in the org timezone. billingCycleStartDay=N → [N of this-or-last month,
   * N-1 of the next]; null → calendar month.
   */
  resolveCurrentPeriod(
    todayStr: string,
    cycleStartDay: number | null,
  ): { fromDate: string; toDate: string } {
    const [y, m, d] = todayStr.split('-').map(Number);
    if (!cycleStartDay || cycleStartDay <= 1) {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0)); // last day of month
      return {
        fromDate: start.toISOString().slice(0, 10),
        toDate: end.toISOString().slice(0, 10),
      };
    }
    const anchor =
      d >= cycleStartDay
        ? new Date(Date.UTC(y, m - 1, cycleStartDay))
        : new Date(Date.UTC(y, m - 2, cycleStartDay));
    const end = new Date(anchor.getTime());
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(end.getUTCDate() - 1);
    return {
      fromDate: anchor.toISOString().slice(0, 10),
      toDate: end.toISOString().slice(0, 10),
    };
  }

  private adjustmentToResponse(r: {
    id: string;
    groupId: string;
    userId: string;
    entryDate: Date;
    type: string;
    amount: number;
    reason: string;
    refRecordId: string | null;
    refGuestId: string | null;
    refRequestId: string | null;
    createdBy: string;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      groupId: r.groupId,
      userId: r.userId,
      entryDate: r.entryDate.toISOString().slice(0, 10),
      type: r.type,
      amount: r.amount,
      // Convenience for clients: signed effect on the bill.
      signedAmount: r.type === 'debit' ? r.amount : -r.amount,
      reason: r.reason,
      refRecordId: r.refRecordId,
      refGuestId: r.refGuestId,
      refRequestId: r.refRequestId,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    };
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
