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
import { NoticesService } from '../notices/notices.service';
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
    // command_6 (survey 2026-07-13): bell alert for the member-consent debit
    // workflow. Optional so existing TestingModules keep working unchanged.
    @Optional()
    @Inject(NoticesService)
    private readonly notices: NoticesService | null = null,
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

    // CREDIT-001: finalizing changes the carry-forward opening balance of
    // every later period — invalidate cached summaries.
    await this.bumpBillingVersion(dto.groupId);

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

    // CREDIT-001: the reopened period no longer feeds carry-forward.
    await this.bumpBillingVersion(period.groupId);

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

    // CREDIT-001: re-locking re-enables carry-forward from this period.
    await this.bumpBillingVersion(period.groupId);

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
        // REF-001 (survey 2026-07-13): billing policy for the refund cap —
        // the member's true net position depends on what the group bills.
        billSkippedMeals: true,
        guestAttendanceEnabled: true,
        billNoShowGuests: true,
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

    // FR-FAIR-001 (LOOP-010): a debit (liability increase) needs member
    // consent. Two consent paths (command_6 survey 2026-07-13):
    //   • refRequestId present → an APPROVED correction request of the same
    //     member proves consent — the debit posts immediately (legacy path).
    //   • no refRequestId → the debit is created PENDING and the member is
    //     asked to approve it from their bell / billing screen. It counts in
    //     billing only after the member approves — never if rejected.
    let entryStatus: 'posted' | 'pending' = 'posted';
    if (dto.type === 'debit') {
      if (!dto.refRequestId) {
        entryStatus = 'pending';
      } else {
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

    const entryData = {
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
      status: entryStatus,
    };

    // REF-001 hard cap (survey 2026-07-13): a refund returns the member's own
    // money — it may NEVER exceed the available refundable credit (the
    // member's all-time net position: billed meals + guest charges + posted
    // ledger, payable-positive). Checked INSIDE a transaction under a
    // per-member advisory lock so concurrent refunds cannot combine into an
    // over-refund. Rejected attempts are audit-logged (admin, requested,
    // available) per the locked business rules.
    let entry: any;
    let remainingCreditRupees: number | null = null;
    if (dto.type === 'refund') {
      const requestedRupees = Math.round(dto.amount / 100);
      entry = await (this.prisma as any).$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`bill:${dto.groupId}:${dto.userId}`}))`;
        const net = await this.computeMemberNetBalance(
          tx,
          organizationId,
          dto.groupId,
          dto.userId,
          {
            billSkippedMeals: (group as any).billSkippedMeals === true,
            guestAttendanceEnabled: (group as any).guestAttendanceEnabled === true,
            billNoShowGuests: (group as any).billNoShowGuests !== false,
          },
        );
        const available = Math.max(0, -net);
        if (requestedRupees > available) {
          this.audit.log({
            organizationId,
            actorId: adminId,
            targetId: dto.userId,
            targetType: 'BillingLedgerEntry',
            action: 'create',
            metadata: {
              decision: 'rejected_over_refund',
              groupId: dto.groupId,
              userId: dto.userId,
              requestedPaise: dto.amount,
              availableCreditRupees: available,
              reason: dto.reason,
            },
            requestId,
          });
          throw new UnprocessableEntityException({
            message: `Refund amount exceeds the member's available refundable credit of ₹${available}`,
            code: 'REFUND_EXCEEDS_CREDIT',
            errors: { amount: `Available refundable credit is ₹${available}` },
          });
        }
        remainingCreditRupees = available - requestedRupees;
        return tx.billingLedgerEntry.create({ data: entryData });
      });
    } else {
      entry = await (this.prisma as any).billingLedgerEntry.create({
        data: entryData,
      });
    }

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
        status: entryStatus,
        ...(remainingCreditRupees !== null
          ? { remainingCreditRupees }
          : {}),
        ...(dto.refRequestId ? { refRequestId: dto.refRequestId } : {}),
      },
      requestId,
    });

    // Pending debits don't change any bill yet — no cache invalidation needed.
    if (entryStatus === 'posted') {
      await this.bumpBillingVersion(dto.groupId);
    }

    // command_6 (survey 2026-07-13): a PENDING debit lands in the member's
    // bell for approval — best-effort, the entry itself is already saved.
    if (entryStatus === 'pending' && this.notices) {
      const rupees = (dto.amount / 100).toFixed(2);
      void this.notices
        .createMemberAlert({
          organizationId,
          groupId: dto.groupId,
          actorId: adminId,
          targetUserId: dto.userId,
          title: 'Charge approval requested',
          body: `+₹${rupees} — ${dto.reason}. Review and approve or decline from your Billing screen.`,
          linkType: 'billingAdjustments',
        })
        .catch((err) =>
          this.logger.warn(`debit approval notice failed: ${(err as Error).message}`),
        );
    }

    // Transparency (LOOP-035): the member always learns about bill changes.
    const pushCopy = (() => {
      const rupees = `₹${(dto.amount / 100).toFixed(2)}`;
      switch (dto.type) {
        case 'debit':
          return entryStatus === 'pending'
            ? {
                title: 'Approval needed: proposed charge',
                body: `+${rupees} — ${dto.reason}. Approve or decline in Billing.`,
              }
            : {
                title: 'A charge was added to your bill',
                body: `+${rupees} — ${dto.reason}`,
              };
        case 'refund':
          // REF-001: a refund consumes credit (returns money to the member).
          return {
            title: 'A refund was issued to you',
            body: `${rupees} returned — ${dto.reason}`,
          };
        default:
          return {
            title: 'A credit was applied to your bill',
            body: `−${rupees} — ${dto.reason}`,
          };
      }
    })();
    void this.prisma.user
      .findUnique({ where: { id: dto.userId }, select: { fcmToken: true } })
      .then((u) =>
        u?.fcmToken && this.queue
          ? this.queue.enqueueBatchPush({
              organizationId,
              recipients: [{ userId: dto.userId, fcmToken: u.fcmToken }],
              title: pushCopy.title,
              body: pushCopy.body,
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

  /**
   * command_6 (survey 2026-07-13): the billed member approves or rejects a
   * PENDING debit. Approve → the entry becomes 'posted' and starts counting
   * in billing; reject → 'rejected', never counted. Only the member the entry
   * bills may decide (self-consent — FR-FAIR-001 in workflow form).
   */
  async decideAdjustment(
    memberId: string,
    organizationId: string,
    entryId: string,
    decision: 'approved' | 'rejected',
    requestId?: string,
  ) {
    const entry = await (this.prisma as any).billingLedgerEntry.findFirst({
      where: { id: entryId, organizationId },
    });
    if (!entry) {
      throw new NotFoundException({
        message: 'Adjustment not found',
        errors: { id: 'Does not exist in your organization' },
      });
    }
    if (entry.userId !== memberId) {
      throw new ForbiddenException({
        message: 'Only the billed member can decide this charge',
        errors: { id: 'Not your pending charge' },
      });
    }
    if (entry.status !== 'pending') {
      throw new UnprocessableEntityException({
        message: `This charge was already ${entry.status}`,
        code: 'ALREADY_DECIDED',
        errors: { id: `Status is ${entry.status}` },
      });
    }

    // FR-BILLX-051 still holds at decision time: if the original business
    // date has been finalized while the debit sat pending, the approved
    // charge posts to TODAY (org time) instead of mutating a locked period.
    let entryDate: Date = entry.entryDate;
    let movedToOpenDate = false;
    if (decision === 'approved') {
      const lock = await this.isDateFinalized(
        organizationId,
        entry.groupId,
        entry.entryDate,
      );
      if (lock.locked) {
        const grp = await this.prisma.group.findFirst({
          where: { id: entry.groupId, organizationId },
          select: { organization: { select: { timezone: true } } },
        });
        const tz = grp?.organization?.timezone ?? 'Asia/Kolkata';
        entryDate = toUtcMidnight(getTodayInTimezone(tz));
        const todayLock = await this.isDateFinalized(
          organizationId,
          entry.groupId,
          entryDate,
        );
        if (todayLock.locked) {
          throw new UnprocessableEntityException({
            message:
              'This date lies in a finalized billing period — ask the admin to reopen it first',
            code: 'PERIOD_FINALIZED',
            errors: { id: `Period finalized through ${todayLock.periodEnd}` },
          });
        }
        movedToOpenDate = true;
      }
    }

    const updated = await (this.prisma as any).billingLedgerEntry.update({
      where: { id: entryId },
      data: {
        status: decision === 'approved' ? 'posted' : 'rejected',
        decidedBy: memberId,
        decidedAt: new Date(),
        ...(movedToOpenDate ? { entryDate } : {}),
      },
    });

    this.audit.log({
      organizationId,
      actorId: memberId,
      targetId: entryId,
      targetType: 'BillingLedgerEntry',
      action: 'update',
      metadata: {
        decision,
        groupId: entry.groupId,
        amount: entry.amount,
        ...(movedToOpenDate
          ? { movedToOpenDate: entryDate.toISOString().slice(0, 10) }
          : {}),
      },
      requestId,
    });

    if (decision === 'approved') {
      await this.bumpBillingVersion(entry.groupId);
    }

    return this.adjustmentToResponse(updated);
  }

  /**
   * command_6 (survey 2026-07-13): the caller's own PENDING debits — powers
   * the student "charge approval" card. Self-scoped; no other member's rows.
   */
  async listMyPendingAdjustments(organizationId: string, userId: string) {
    const rows = await (this.prisma as any).billingLedgerEntry.findMany({
      where: { organizationId, userId, status: 'pending' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return { data: rows.map((r: any) => this.adjustmentToResponse(r)) };
  }

  /**
   * REF-001: the member's all-time net position (whole ₹, payable-positive)
   * inside one group — billed meals (per group policy) + guest charges +
   * POSTED signed ledger. Available refundable credit = max(0, −net).
   * Runs on the [tx] client so the refund cap check and the insert commit
   * atomically under the advisory lock.
   */
  private async computeMemberNetBalance(
    tx: any,
    organizationId: string,
    groupId: string,
    userId: string,
    policy: {
      billSkippedMeals: boolean;
      guestAttendanceEnabled: boolean;
      billNoShowGuests: boolean;
    },
  ): Promise<number> {
    const billedStatuses = policy.billSkippedMeals
      ? ['present', 'skipped', 'absent']
      : ['present'];
    const [meal, guest, ledger] = await Promise.all([
      tx.attendanceRecord.aggregate({
        where: {
          organizationId,
          groupId,
          userId,
          status: { in: billedStatuses },
        },
        _sum: { price: true },
      }),
      policy.guestAttendanceEnabled
        ? tx.mealGuest.aggregate({
            where: {
              organizationId,
              groupId,
              hostUserId: userId,
              status: {
                in: policy.billNoShowGuests ? ['booked', 'no_show'] : ['booked'],
              },
              pendingApproval: false,
            },
            _sum: { priceSnapshot: true },
          })
        : Promise.resolve({ _sum: { priceSnapshot: 0 } }),
      tx.billingLedgerEntry.groupBy({
        by: ['type'],
        where: { organizationId, groupId, userId, status: 'posted' },
        _sum: { amount: true },
      }),
    ]);
    let adjPaise = 0;
    for (const r of ledger as Array<{ type: string; _sum: { amount: number | null } }>) {
      adjPaise += (r._sum.amount ?? 0) * (r.type === 'credit' ? -1 : 1);
    }
    return (
      (meal._sum.price ?? 0) +
      (guest._sum?.priceSnapshot ?? 0) +
      Math.round(adjPaise / 100)
    );
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
   * by type). Sign convention (REF-001, survey 2026-07-13, payable-positive):
   * debit AND refund positive (a refund returns money to the member and so
   * CONSUMES their credit — it is never a discount), credit negative.
   * Only POSTED entries count — pending debits await member approval and
   * rejected ones never bill (member-consent workflow).
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
          status: 'posted',
        },
        _sum: { amount: true },
      });
    // Accumulate in paise first, convert once per member — so multi-entry
    // sums round on the total, never per entry.
    const paiseByUser = new Map<string, number>();
    for (const r of rows) {
      const signed = (r._sum.amount ?? 0) * (r.type === 'credit' ? -1 : 1);
      paiseByUser.set(r.userId, (paiseByUser.get(r.userId) ?? 0) + signed);
    }
    const byUser = new Map<string, number>();
    for (const [userId, paise] of paiseByUser) {
      byUser.set(userId, Math.round(paise / 100));
    }
    return byUser;
  }

  /**
   * Pass 12 (FR-BILLX-020/041) + SRS Module 03 BILL-012 (survey Q8/Q20):
   * the group's current billing period computed in the org timezone.
   * billingCycleStartDay=N (1–31) → [effective N of this-or-last month,
   * day before the next effective N]; null → calendar month.
   *
   * When the configured anchor day does not exist in a month the EFFECTIVE
   * anchor clamps to that month's last calendar day — the configured value
   * itself never changes. Anchor-31 example: 31 Jan → 27 Feb, 28 Feb →
   * 30 Mar, 31 Mar → 29 Apr. Every date belongs to exactly one period —
   * no gaps, no overlaps, leap years automatic.
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
    // months0 is 0-based and may be negative/overflowing — Date.UTC
    // normalizes it, so previous/next-month math stays trivial.
    const effectiveAnchor = (year: number, months0: number): Date => {
      const lastDay = new Date(Date.UTC(year, months0 + 1, 0)).getUTCDate();
      return new Date(
        Date.UTC(year, months0, Math.min(cycleStartDay, lastDay)),
      );
    };
    const anchorThisMonth = effectiveAnchor(y, m - 1);
    const inCurrent = d >= anchorThisMonth.getUTCDate();
    const start = inCurrent ? anchorThisMonth : effectiveAnchor(y, m - 2);
    const nextAnchor = inCurrent ? effectiveAnchor(y, m) : anchorThisMonth;
    const end = new Date(nextAnchor.getTime());
    end.setUTCDate(end.getUTCDate() - 1);
    return {
      fromDate: start.toISOString().slice(0, 10),
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
    status?: string | null;
    decidedAt?: Date | null;
    decidedBy?: string | null;
  }) {
    return {
      id: r.id,
      groupId: r.groupId,
      userId: r.userId,
      entryDate: r.entryDate.toISOString().slice(0, 10),
      type: r.type,
      amount: r.amount,
      // Convenience for clients: signed effect on the bill (REF-001:
      // refund consumes credit → positive, like debit; credit negative).
      signedAmount: r.type === 'credit' ? -r.amount : r.amount,
      reason: r.reason,
      refRecordId: r.refRecordId,
      refGuestId: r.refGuestId,
      refRequestId: r.refRequestId,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      // command_6 (survey 2026-07-13): member-consent debit workflow fields.
      status: r.status ?? 'posted',
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decidedBy: r.decidedBy ?? null,
    };
  }

  /**
   * CREDIT-001 (survey 2026-07-13): per-member OPENING BALANCES (whole ₹,
   * payable-positive) for a period starting at [fromDate] — the closing
   * position of everything up to and including the latest FINALIZED billing
   * period that ended before [fromDate]. No finalized period → no
   * carry-forward (empty map), exactly as specified: carry-forward happens
   * only once the previous period is finalized and locked. Zero balances are
   * dropped (they carry nothing). Three parallel indexed aggregates.
   */
  async computeOpeningBalances(
    organizationId: string,
    groupId: string,
    fromDate: Date,
    policy: {
      billSkippedMeals?: boolean;
      guestAttendanceEnabled?: boolean;
      billNoShowGuests?: boolean;
    },
  ): Promise<{ byUser: Map<string, number>; carriedThrough: string | null }> {
    const lastFinal = await this.prisma.billingPeriod.findFirst({
      where: {
        organizationId,
        groupId,
        status: 'finalized',
        periodEnd: { lt: fromDate },
      },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    });
    if (!lastFinal) return { byUser: new Map(), carriedThrough: null };
    const cutoff = lastFinal.periodEnd;

    const billedStatuses =
      policy.billSkippedMeals === true
        ? ['present', 'skipped', 'absent']
        : ['present'];
    const [meals, guests, ledger] = await Promise.all([
      this.prisma.attendanceRecord.groupBy({
        by: ['userId'],
        where: {
          organizationId,
          groupId,
          attendanceDate: { lte: cutoff },
          status: { in: billedStatuses as any },
        },
        _sum: { price: true },
      }),
      policy.guestAttendanceEnabled === true
        ? this.prisma.mealGuest.groupBy({
            by: ['hostUserId'],
            where: {
              organizationId,
              groupId,
              attendanceDate: { lte: cutoff },
              status: {
                in:
                  policy.billNoShowGuests !== false
                    ? ['booked', 'no_show']
                    : ['booked'],
              },
              pendingApproval: false,
            },
            _sum: { priceSnapshot: true },
          })
        : Promise.resolve([] as any[]),
      (this.prisma as any).billingLedgerEntry.groupBy({
        by: ['userId', 'type'],
        where: {
          organizationId,
          groupId,
          entryDate: { lte: cutoff },
          status: 'posted',
        },
        _sum: { amount: true },
      }),
    ]);

    const byUser = new Map<string, number>();
    for (const m of meals as Array<{ userId: string; _sum: { price: number | null } }>) {
      byUser.set(m.userId, (byUser.get(m.userId) ?? 0) + (m._sum.price ?? 0));
    }
    for (const g of guests as Array<{ hostUserId: string; _sum: { priceSnapshot: number | null } }>) {
      byUser.set(
        g.hostUserId,
        (byUser.get(g.hostUserId) ?? 0) + (g._sum.priceSnapshot ?? 0),
      );
    }
    // Ledger is paise — accumulate then convert once per member (REF-001
    // signs: credit −, debit/refund +).
    const paise = new Map<string, number>();
    for (const l of ledger as Array<{ userId: string; type: string; _sum: { amount: number | null } }>) {
      paise.set(
        l.userId,
        (paise.get(l.userId) ?? 0) +
          (l._sum.amount ?? 0) * (l.type === 'credit' ? -1 : 1),
      );
    }
    for (const [uid, p] of paise) {
      byUser.set(uid, (byUser.get(uid) ?? 0) + Math.round(p / 100));
    }
    for (const [uid, v] of byUser) {
      if (v === 0) byUser.delete(uid);
    }
    return {
      byUser,
      carriedThrough: cutoff.toISOString().slice(0, 10),
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

  /**
   * Immutable reprint snapshot: per-member present count + billed total.
   * CREDIT-001 (survey 2026-07-13, additive JSON fields): the snapshot now
   * also captures each member's openingBalance (carried from the previous
   * finalized period), in-period billedAmount/guestAmount/adjustments and the
   * resulting closingBalance — so every carry-forward chain is auditable from
   * the locked snapshots alone. Legacy fields keep their exact meaning.
   */
  private async buildTotalsSnapshot(
    organizationId: string,
    groupId: string,
    start: Date,
    end: Date,
  ) {
    const policyRow = await this.prisma.group.findFirst({
      where: { id: groupId, organizationId },
      select: {
        billSkippedMeals: true,
        guestAttendanceEnabled: true,
        billNoShowGuests: true,
      },
    });
    const policy = {
      billSkippedMeals: (policyRow as any)?.billSkippedMeals === true,
      guestAttendanceEnabled: policyRow?.guestAttendanceEnabled === true,
      billNoShowGuests: policyRow?.billNoShowGuests !== false,
    };
    const billedStatuses = policy.billSkippedMeals
      ? ['present', 'skipped', 'absent']
      : ['present'];

    const [perMember, billedPerMember, guests, adjustments, opening] =
      await Promise.all([
        this.prisma.attendanceRecord.groupBy({
          by: ['userId'],
          where: {
            organizationId,
            groupId,
            attendanceDate: { gte: start, lte: end },
            status: 'present',
          },
          _count: { _all: true },
          _sum: { price: true },
        }),
        this.prisma.attendanceRecord.groupBy({
          by: ['userId'],
          where: {
            organizationId,
            groupId,
            attendanceDate: { gte: start, lte: end },
            status: { in: billedStatuses as any },
          },
          _sum: { price: true },
        }),
        policy.guestAttendanceEnabled
          ? this.prisma.mealGuest.groupBy({
              by: ['hostUserId'],
              where: {
                organizationId,
                groupId,
                attendanceDate: { gte: start, lte: end },
                status: {
                  in: policy.billNoShowGuests
                    ? ['booked', 'no_show']
                    : ['booked'],
                },
                pendingApproval: false,
              },
              _sum: { priceSnapshot: true },
            })
          : Promise.resolve([] as any[]),
        this.sumAdjustmentsByUser(organizationId, groupId, start, end),
        this.computeOpeningBalances(organizationId, groupId, start, policy),
      ]);

    const presentByUser = new Map(
      perMember.map((m) => [m.userId, m] as const),
    );
    const billedByUser = new Map(
      (billedPerMember as Array<{ userId: string; _sum: { price: number | null } }>).map(
        (m) => [m.userId, m._sum.price ?? 0] as const,
      ),
    );
    const guestByUser = new Map(
      (guests as Array<{ hostUserId: string; _sum: { priceSnapshot: number | null } }>).map(
        (g) => [g.hostUserId, g._sum.priceSnapshot ?? 0] as const,
      ),
    );
    const allIds = new Set<string>([
      ...presentByUser.keys(),
      ...billedByUser.keys(),
      ...guestByUser.keys(),
      ...adjustments.keys(),
      ...opening.byUser.keys(),
    ]);

    return {
      capturedAt: new Date().toISOString(),
      // CREDIT-001: which finalized period this snapshot's opening balances
      // were carried from (null = first finalized period of the group).
      openingCarriedThrough: opening.carriedThrough,
      members: [...allIds].map((uid) => {
        const present = presentByUser.get(uid);
        const billedAmount = billedByUser.get(uid) ?? 0;
        const guestAmount = guestByUser.get(uid) ?? 0;
        const adj = adjustments.get(uid) ?? 0;
        const openingBalance = opening.byUser.get(uid) ?? 0;
        return {
          userId: uid,
          presentCount: present?._count._all ?? 0,
          totalAmount: present?._sum.price ?? 0,
          billedAmount,
          guestAmount,
          adjustments: adj,
          openingBalance,
          closingBalance: openingBalance + billedAmount + guestAmount + adj,
        };
      }),
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
