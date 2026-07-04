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
 * Pass 12 — append-only billing ledger (FR-BILLX-030/031/033):
 *   • debits (liability increases) demand consent proof (FR-FAIR-001,
 *     LOOP-010) — an APPROVED correction request of the same member;
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
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
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

  it('debit WITHOUT consent proof → 403 CONSENT_REQUIRED (LOOP-010)', async () => {
    await expect(
      service.createAdjustment('admin1', 'org1', { ...base, type: 'debit' } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.billingLedgerEntry.create).not.toHaveBeenCalled();
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

  it('signed sums: debit positive, credit/refund negative (FR-BILLX-043)', async () => {
    prisma.billingLedgerEntry.groupBy.mockResolvedValue([
      { userId: 'u1', type: 'debit', _sum: { amount: 3000 } },
      { userId: 'u1', type: 'credit', _sum: { amount: 1000 } },
      { userId: 'u2', type: 'refund', _sum: { amount: 500 } },
    ]);
    const map = await service.sumAdjustmentsByUser(
      'org1',
      'g1',
      new Date('2026-07-01'),
      new Date('2026-07-31'),
    );
    expect(map.get('u1')).toBe(2000);
    expect(map.get('u2')).toBe(-500);
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
});
