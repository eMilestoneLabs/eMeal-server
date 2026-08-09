import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BillingService } from '../billing.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { RedisService } from '../../../redis/redis.service';

/**
 * Pass 12 — append-only billing ledger (FR-BILLX-030/031/033), updated by
 * command_6 (survey 2026-07-13):
 *   • a debit WITHOUT an approved correction request now becomes a PENDING
 *     entry the billed member must approve (bell workflow) — never a 403;
 *   • REF-001: refund consumes credit → signed POSITIVE like debit, and is
 *     hard-capped at the member's available refundable credit;
 *   • credits post freely, are audited, and bump the billing cache version;
 *   • entries can never post into a finalized period (FR-BILLX-051).
 */
describe('BillingService adjustments (Pass 12)', () => {
  let service: BillingService;
  let prisma: any;
  let audit: { log: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    prisma = {
      group: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'g1',
          organization: { timezone: 'Asia/Kolkata' },
          // Live-Test-15 ISSUE-2: these adjustment cases all model a BILLABLE
          // group. Meal Pricing is now the master gate for meal billing, so the
          // fixture must state it explicitly — otherwise every case would fail
          // on BILLING_NOT_APPLICABLE, which is a fixture gap, not a defect.
          mealsEnabled: true,
          mealPricingEnabled: true,
        }),
      },
      groupMember: { findFirst: jest.fn().mockResolvedValue({ userId: 'u1' }) },
      attendanceCorrectionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      billingPeriod: { findFirst: jest.fn().mockResolvedValue(null) },
      billingLedgerEntry: {
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'led1',
          ...data,
          createdAt: new Date(),
        })),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'led1',
          organizationId: 'org1',
          groupId: 'g1',
          userId: 'u1',
          entryDate: new Date('2026-07-10T00:00:00.000Z'),
          type: 'debit',
          amount: 5000,
          reason: 'r',
          refRecordId: null,
          refGuestId: null,
          refRequestId: null,
          createdBy: 'admin1',
          createdAt: new Date(),
          ...data,
        })),
      },
      attendanceRecord: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { price: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      mealGuest: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { priceSnapshot: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    // REF-001: the refund cap runs inside an interactive transaction under a
    // per-member advisory lock — the tx client reuses the same mocks.
    prisma.$transaction = jest.fn(async (fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    audit = { log: jest.fn() };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = module.get(BillingService);
  });

  const base = {
    groupId: 'g1',
    userId: 'u1',
    amount: 5000,
    reason: 'wrongly charged lunch',
  };

  it('debit WITHOUT consent proof → PENDING member-approval entry (survey 2026-07-13)', async () => {
    const res: any = await service.createAdjustment('admin1', 'org1', {
      ...base,
      type: 'debit',
    } as any);
    expect(res.status).toBe('pending');
    expect(prisma.billingLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'pending' }) }),
    );
    // A pending debit does not bill anyone yet — no cache invalidation.
    expect(redis.set).not.toHaveBeenCalledWith('bill:ver:g1', expect.any(String));
  });

  it('debit with a NON-approved reference → 403 (consent must be real)', async () => {
    await expect(
      service.createAdjustment('admin1', 'org1', {
        ...base,
        type: 'debit',
        refRequestId: 'acr-rejected',
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('debit with an APPROVED request of the member posts and audits', async () => {
    prisma.attendanceCorrectionRequest.findFirst.mockResolvedValue({ id: 'acr1' });
    const res: any = await service.createAdjustment('admin1', 'org1', {
      ...base,
      type: 'debit',
      refRequestId: 'acr1',
    } as any);
    expect(res.signedAmount).toBe(5000);
    expect(audit.log).toHaveBeenCalled();
  });

  it('credit posts freely, audits, and bumps the billing cache version', async () => {
    const res: any = await service.createAdjustment('admin1', 'org1', {
      ...base,
      type: 'credit',
    } as any);
    expect(res.signedAmount).toBe(-5000);
    expect(prisma.billingLedgerEntry.create).toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith('bill:ver:g1', expect.any(String));
  });

  it('entry dated inside a FINALIZED period → 422 PERIOD_FINALIZED (FR-BILLX-051)', async () => {
    prisma.billingPeriod.findFirst.mockResolvedValue({
      periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    });
    await expect(
      service.createAdjustment('admin1', 'org1', {
        ...base,
        type: 'credit',
        entryDate: '2026-06-15',
      } as any),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(prisma.billingLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('signed sums (REF-001): debit AND refund positive, credit negative, in ₹', async () => {
    // Ledger amounts are paise; the billing engine works in whole ₹, so the
    // returned sums are ₹ (paise ÷ 100). u1: +₹300 debit −₹100 credit = ₹200.
    // u2: a ₹50 refund CONSUMES credit → +₹50 (never a discount).
    prisma.billingLedgerEntry.groupBy.mockResolvedValue([
      { userId: 'u1', type: 'debit', _sum: { amount: 30000 } },
      { userId: 'u1', type: 'credit', _sum: { amount: 10000 } },
      { userId: 'u2', type: 'refund', _sum: { amount: 5000 } },
    ]);
    const map = await service.sumAdjustmentsByUser(
      'org1',
      'g1',
      new Date('2026-07-01'),
      new Date('2026-07-31'),
    );
    expect(map.get('u1')).toBe(200);
    expect(map.get('u2')).toBe(50);
    // Only POSTED entries bill — pending/rejected debits are excluded.
    expect(prisma.billingLedgerEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'posted' }) }),
    );
  });

  // ── REF-001 refund cap (survey 2026-07-13) ────────────────────

  it('refund within available credit posts (member has ₹100 credit, refund ₹50)', async () => {
    // Member position: ₹0 meals, −₹100 posted credit → available credit ₹100.
    prisma.billingLedgerEntry.groupBy.mockResolvedValue([
      { type: 'credit', _sum: { amount: 10000 } },
    ]);
    const res: any = await service.createAdjustment('admin1', 'org1', {
      ...base,
      type: 'refund',
    } as any);
    expect(res.type).toBe('refund');
    expect(res.signedAmount).toBe(5000); // consumes credit → positive
    expect(prisma.billingLedgerEntry.create).toHaveBeenCalled();
  });

  it('refund exceeding available credit → 422 REFUND_EXCEEDS_CREDIT, audited, no row', async () => {
    // Available credit ₹100 (posted credit ₹100) but refund asks ₹500.
    prisma.billingLedgerEntry.groupBy.mockResolvedValue([
      { type: 'credit', _sum: { amount: 10000 } },
    ]);
    await expect(
      service.createAdjustment('admin1', 'org1', {
        ...base,
        amount: 50000,
        type: 'refund',
      } as any),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(prisma.billingLedgerEntry.create).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ decision: 'rejected_over_refund' }),
      }),
    );
  });

  it('refund cap counts billed meals against credit (₹100 credit, ₹80 meals → cap ₹20)', async () => {
    prisma.billingLedgerEntry.groupBy.mockResolvedValue([
      { type: 'credit', _sum: { amount: 10000 } },
    ]);
    prisma.attendanceRecord.aggregate.mockResolvedValue({ _sum: { price: 80 } });
    await expect(
      service.createAdjustment('admin1', 'org1', {
        ...base,
        amount: 5000, // ₹50 > ₹20 available
        type: 'refund',
      } as any),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  // ── Member decision on pending debits (survey 2026-07-13) ─────────

  const pendingEntry = {
    id: 'led1',
    organizationId: 'org1',
    groupId: 'g1',
    userId: 'u1',
    entryDate: new Date('2026-07-10T00:00:00.000Z'),
    type: 'debit',
    amount: 5000,
    reason: 'r',
    refRecordId: null,
    refGuestId: null,
    refRequestId: null,
    createdBy: 'admin1',
    createdAt: new Date(),
    status: 'pending',
    decidedAt: null,
    decidedBy: null,
  };

  it('member approves own pending debit → posted + billing version bump', async () => {
    prisma.billingLedgerEntry.findFirst.mockResolvedValue(pendingEntry);
    const res: any = await service.decideAdjustment('u1', 'org1', 'led1', 'approved');
    expect(res.status).toBe('posted');
    expect(prisma.billingLedgerEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'posted' }) }),
    );
    expect(redis.set).toHaveBeenCalledWith('bill:ver:g1', expect.any(String));
  });

  it('member rejects own pending debit → rejected, never billed, no bump', async () => {
    prisma.billingLedgerEntry.findFirst.mockResolvedValue(pendingEntry);
    const res: any = await service.decideAdjustment('u1', 'org1', 'led1', 'rejected');
    expect(res.status).toBe('rejected');
    expect(redis.set).not.toHaveBeenCalledWith('bill:ver:g1', expect.any(String));
  });

  it("another member cannot decide someone else's charge → 403", async () => {
    prisma.billingLedgerEntry.findFirst.mockResolvedValue(pendingEntry);
    await expect(
      service.decideAdjustment('u_other', 'org1', 'led1', 'approved'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('already-decided entries cannot be re-decided → 422 ALREADY_DECIDED', async () => {
    prisma.billingLedgerEntry.findFirst.mockResolvedValue({
      ...pendingEntry,
      status: 'posted',
    });
    await expect(
      service.decideAdjustment('u1', 'org1', 'led1', 'approved'),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  // ── CREDIT-001 opening balances (survey 2026-07-13) ───────────

  it('no finalized period before the range → no carry-forward (opening empty)', async () => {
    prisma.billingPeriod.findFirst.mockResolvedValue(null);
    const res = await service.computeOpeningBalances('org1', 'g1', new Date('2026-07-01'), {});
    expect(res.byUser.size).toBe(0);
    expect(res.carriedThrough).toBeNull();
  });

  it('opening = meals + guests + signed ledger through the last finalized period', async () => {
    prisma.billingPeriod.findFirst.mockResolvedValue({
      periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    });
    // u1 ate ₹700, paid ₹1000 advance (credit) → opening −₹300 (org owes).
    // u2 hosted ₹150 guests and got a ₹50 refund of prior credit → +₹200.
    prisma.attendanceRecord.groupBy.mockResolvedValue([
      { userId: 'u1', _sum: { price: 700 } },
    ]);
    prisma.mealGuest.groupBy.mockResolvedValue([
      { hostUserId: 'u2', _sum: { priceSnapshot: 150 } },
    ]);
    prisma.billingLedgerEntry.groupBy.mockResolvedValue([
      { userId: 'u1', type: 'credit', _sum: { amount: 100000 } },
      { userId: 'u2', type: 'refund', _sum: { amount: 5000 } },
    ]);
    const res = await service.computeOpeningBalances('org1', 'g1', new Date('2026-07-01'), {
      guestAttendanceEnabled: true,
    });
    expect(res.byUser.get('u1')).toBe(-300);
    expect(res.byUser.get('u2')).toBe(200);
    expect(res.carriedThrough).toBe('2026-06-30');
  });

  it('billing cycle periods resolve correctly (FR-BILLX-020)', () => {
    // Calendar month (null cycle day).
    expect(service.resolveCurrentPeriod('2026-07-04', null)).toEqual({
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
    });
    // Cycle day 5, today before the 5th → previous month's 5th.
    expect(service.resolveCurrentPeriod('2026-07-04', 5)).toEqual({
      fromDate: '2026-06-05',
      toDate: '2026-07-04',
    });
    // Cycle day 5, today on/after the 5th → this month's 5th.
    expect(service.resolveCurrentPeriod('2026-07-05', 5)).toEqual({
      fromDate: '2026-07-05',
      toDate: '2026-08-04',
    });
  });

  // SRS Module 03 BILL-012 (survey Q20): anchor days 29–31 clamp to a short
  // month's last calendar day — the SRS's exact anchor-31 examples.
  it('anchor 31 clamps to short months with no gaps/overlaps (BILL-012)', () => {
    // Mid-Feb (non-leap 2027), anchor 31 → period is 31 Jan → 27 Feb.
    expect(service.resolveCurrentPeriod('2027-02-15', 31)).toEqual({
      fromDate: '2027-01-31',
      toDate: '2027-02-27',
    });
    // 28 Feb (effective anchor for Feb) starts the next period → 30 Mar.
    expect(service.resolveCurrentPeriod('2027-02-28', 31)).toEqual({
      fromDate: '2027-02-28',
      toDate: '2027-03-30',
    });
    // 31 Mar → 29 Apr (April's effective anchor is the 30th).
    expect(service.resolveCurrentPeriod('2027-03-31', 31)).toEqual({
      fromDate: '2027-03-31',
      toDate: '2027-04-29',
    });
    // Leap year: Feb 2028's effective anchor is the 29th.
    expect(service.resolveCurrentPeriod('2028-02-29', 31)).toEqual({
      fromDate: '2028-02-29',
      toDate: '2028-03-30',
    });
    // 30 Apr (effective anchor) → 30 May (day before 31 May).
    expect(service.resolveCurrentPeriod('2027-04-30', 31)).toEqual({
      fromDate: '2027-04-30',
      toDate: '2027-05-30',
    });
  });
});
