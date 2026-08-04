import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RetentionService } from '../retention.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditService } from '../../../audit/audit.service';
import { StorageService } from '../../../storage/storage.service';
import { BillingService } from '../../billing/billing.service';
import { NoticesService } from '../../notices/notices.service';
import { QueueService } from '../../../queue/queue.service';

/**
 * Billing-cycle-aligned retention — retain N COMPLETE billing cycles.
 *
 * Invariants proven here:
 *   • the purge boundary is a real CYCLE END, never `createdAt + 3 months`
 *     and never a drifting `now + 3 months`;
 *   • the boundary is FROZEN on the row, so a late/retried sweep can never let
 *     it drift forward into the ACTIVE cycle;
 *   • the admin is warned during the final 7 days BEFORE the boundary, while
 *     the data still exists (there is no post-cycle grace period);
 *   • the HARD financial gate: previous closing must equal next opening, or
 *     NOT ONE row is deleted;
 *   • archive-before-delete still holds;
 *   • every purge stays group- and organization-scoped.
 */
describe('RetentionService (billing-cycle retention)', () => {
  let service: RetentionService;
  let prisma: any;
  let storage: { uploadNoticeAttachment: jest.Mock };
  let billing: {
    resolveCurrentPeriod: jest.Mock;
    finalizePeriod: jest.Mock;
    bumpBillingVersion: jest.Mock;
    computeOpeningBalances: jest.Mock;
    refinalizePeriod: jest.Mock;
  };
  let notices: { createRequestAlert: jest.Mock };
  let redis: { setDedup: jest.Mock };
  let audit: { log: jest.Mock };
  let queue: { enqueueBatchPush: jest.Mock };

  const DAY = 24 * 60 * 60 * 1000;

  let finalizedPeriod: any = null;
  let reopenedPeriod: { id: string } | null = null;

  function group(overrides: Record<string, unknown> = {}) {
    return {
      id: 'g1',
      organizationId: 'org1',
      name: 'Hostel A',
      adminId: 'admin1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      mealPricingEnabled: true,
      billingCycleStartDay: null,
      retentionReviewAt: null,
      retentionPurgeThrough: null,
      organization: { timezone: 'Asia/Kolkata' },
      ...overrides,
    };
  }

  const attendanceRow = {
    id: 'a1',
    attendanceDate: new Date('2026-02-01T00:00:00.000Z'),
    userId: 'u1',
    mealId: 'm1',
    status: 'present',
    preference: null,
    price: 50,
    source: 'self',
    markedAt: new Date('2026-02-01T08:00:00.000Z'),
    user: { name: 'Member One', email: 'one@x.com' },
    meal: { name: 'Breakfast', slotKey: 'breakfast' },
  };

  beforeEach(async () => {
    finalizedPeriod = null;
    reopenedPeriod = null;
    prisma = {
      group: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          billSkippedMeals: false,
          billAbsentMeals: null,
          guestAttendanceEnabled: false,
          billNoShowGuests: true,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      attendanceRecord: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest
          .fn()
          .mockResolvedValue({ attendanceDate: attendanceRow.attendanceDate }),
        findMany: jest.fn().mockResolvedValue([attendanceRow]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      billingPeriod: {
        findFirst: jest
          .fn()
          .mockImplementation(async ({ where }: any) =>
            where?.status === 'reopened' ? reopenedPeriod : finalizedPeriod,
          ),
        findMany: jest
          .fn()
          .mockImplementation(async ({ where }: any) =>
            where?.status === 'reopened'
              ? reopenedPeriod
                ? [
                    {
                      id: reopenedPeriod.id,
                      periodStart: new Date('2026-07-01T00:00:00.000Z'),
                      periodEnd: new Date('2026-07-31T00:00:00.000Z'),
                    },
                  ]
                : []
              : [],
          ),
      },
      mealGuest: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      attendanceCorrectionRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      vacationRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      billingLedgerEntry: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      notice: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      groupArchive: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'arch1',
          ...data,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      groupMember: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    storage = {
      uploadNoticeAttachment: jest
        .fn()
        .mockResolvedValue('https://cdn.example/archive.xlsx'),
    };
    billing = {
      resolveCurrentPeriod: jest
        .fn()
        .mockReturnValue({ fromDate: '2026-07-01', toDate: '2026-07-31' }),
      finalizePeriod: jest.fn().mockResolvedValue({ id: 'bp1' }),
      bumpBillingVersion: jest.fn().mockResolvedValue(undefined),
      computeOpeningBalances: jest
        .fn()
        .mockResolvedValue({ byUser: new Map(), carriedThrough: null }),
      refinalizePeriod: jest.fn().mockResolvedValue({ id: 'bp-reopened' }),
    };
    notices = { createRequestAlert: jest.fn().mockResolvedValue(undefined) };
    redis = { setDedup: jest.fn().mockResolvedValue(true) };
    audit = { log: jest.fn() };
    queue = { enqueueBatchPush: jest.fn().mockResolvedValue('job1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetentionService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: AuditService, useValue: audit },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StorageService, useValue: storage },
        { provide: BillingService, useValue: billing },
        { provide: NoticesService, useValue: notices },
        { provide: QueueService, useValue: queue },
      ],
    }).compile();
    service = module.get(RetentionService);
  });

  // ── Boundary is cycle-aligned and frozen ──────────────────────────────────

  /** Real calendar-month cycle math, so bootstrap walks deterministically. */
  function calendarMonthMock() {
    billing.resolveCurrentPeriod.mockImplementation((todayStr: string) => {
      const [y, m] = todayStr.split('-').map(Number);
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0));
      return {
        fromDate: start.toISOString().slice(0, 10),
        toDate: end.toISOString().slice(0, 10),
      };
    });
  }

  it('bootstrap: a NEW group freezes the boundary at the end of cycle 3', async () => {
    calendarMonthMock();
    // Created this month => cycle 3 ends two months from now (always future).
    const now = new Date();
    const createdAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    prisma.group.findMany.mockResolvedValue([group({ createdAt })]);

    await service.sweep();

    const boundary = prisma.group.updateMany.mock.calls[0][0].data
      .retentionPurgeThrough as Date;
    // Exactly the last day of the 3rd complete cycle — a real cycle end.
    const expected = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0),
    );
    expect(boundary).toEqual(expected);
    // NOT createdAt + 3 months (that would be the 1st, not a cycle end).
    expect(boundary.getUTCDate()).not.toBe(1);
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(notices.createRequestAlert).not.toHaveBeenCalled();
  });

  it('ADOPTION GUARD: a group older than 3 cycles never purges without warning', async () => {
    calendarMonthMock();
    // Created 2 years ago: the naive boundary would be far in the PAST, so the
    // very next sweep would purge with ZERO advance warning.
    prisma.group.findMany.mockResolvedValue([
      group({ createdAt: new Date('2024-01-01T00:00:00.000Z') }),
    ]);

    await service.sweep();

    const boundary = prisma.group.updateMany.mock.calls[0][0].data
      .retentionPurgeThrough as Date;
    // Walked forward far enough that the full 7-day warning window fits...
    expect(boundary.getTime()).toBeGreaterThanOrEqual(
      Date.now() + 6 * DAY,
    );
    // ...and it is still a REAL cycle end (last day of a month), not an
    // arbitrary "today + 7".
    const dayAfter = new Date(boundary.getTime() + DAY);
    expect(dayAfter.getUTCDate()).toBe(1);
    // Nothing destructive happened on adoption.
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('far from the boundary → completely idle', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: new Date(Date.now() + 90 * DAY) }),
    ]);
    await service.sweep();
    expect(notices.createRequestAlert).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(prisma.group.updateMany).not.toHaveBeenCalled();
  });

  // ── 7-day ADVANCE warning, inside the final cycle ─────────────────────────

  it('warns during the final 7 days BEFORE the boundary and deletes nothing', async () => {
    prisma.attendanceRecord.count.mockResolvedValue(12); // data IS at risk
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: new Date(Date.now() + 3 * DAY) }),
    ]);
    await service.sweep();
    expect(notices.createRequestAlert).toHaveBeenCalledTimes(1);
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(storage.uploadNoticeAttachment).not.toHaveBeenCalled();
  });

  it('warning is deduped to once per day', async () => {
    prisma.attendanceRecord.count.mockResolvedValue(12);
    redis.setDedup.mockResolvedValue(false);
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: new Date(Date.now() + 2 * DAY) }),
    ]);
    await service.sweep();
    expect(notices.createRequestAlert).not.toHaveBeenCalled();
  });

  // ── Destructive phase ─────────────────────────────────────────────────────

  it('EMPTY group: no data at risk → NO false-alarm warning is sent', async () => {
    prisma.attendanceRecord.count.mockResolvedValue(0); // nothing to lose
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: new Date(Date.now() + 3 * DAY) }),
    ]);
    await service.sweep();
    expect(notices.createRequestAlert).not.toHaveBeenCalled();
    expect(queue.enqueueBatchPush).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('boundary passed, nothing eligible → boundary advances 3 cycles, nothing deleted', async () => {
    prisma.attendanceRecord.count.mockResolvedValue(0);
    billing.resolveCurrentPeriod
      .mockReturnValueOnce({ fromDate: '2026-08-01', toDate: '2026-08-31' })
      .mockReturnValueOnce({ fromDate: '2026-09-01', toDate: '2026-09-30' })
      .mockReturnValueOnce({ fromDate: '2026-10-01', toDate: '2026-10-31' });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: new Date(Date.now() - 2 * DAY) }),
    ]);
    await service.sweep();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(
      prisma.group.updateMany.mock.calls[0][0].data.retentionPurgeThrough,
    ).toEqual(new Date('2026-10-31T00:00:00.000Z'));
  });

  it('continuity PASS → finalize, archive, purge bounded by the FROZEN cutoff', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 750 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map([['u1', 750]]),
      carriedThrough: '2026-09-30',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    expect(storage.uploadNoticeAttachment).toHaveBeenCalled();
    expect(prisma.groupArchive.create).toHaveBeenCalled();
    const del = prisma.attendanceRecord.deleteMany.mock.calls[0][0];
    expect(del.where.attendanceDate.lte).toEqual(past); // frozen cutoff
    expect(del.where.groupId).toBe('g1'); // group scoped
    expect(del.where.organizationId).toBe('org1'); // org scoped
  });

  it('CONTINUITY FAIL (750 closing would become 0) → NOT ONE row deleted', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 750 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: null,
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(prisma.billingLedgerEntry.deleteMany).not.toHaveBeenCalled();
    expect(storage.uploadNoticeAttachment).not.toHaveBeenCalled();
  });

  it('missing totalsSnapshot → continuity unprovable → NO purge', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = { periodEnd: past, totalsSnapshot: null };
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);
    await service.sweep();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('REOPENED period at the boundary → FORCE-FINALIZED, then purge proceeds', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    reopenedPeriod = { id: 'bp-reopened' };
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 750 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map([['u1', 750]]),
      carriedThrough: '2026-09-30',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    // The hard boundary WINS over the stale reopened state.
    expect(billing.refinalizePeriod).toHaveBeenCalledWith(
      'admin1',
      'org1',
      'bp-reopened',
    );
    // ...but only after the money was proven to carry forward.
    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
  });

  it('force-finalize FAILURE → NOT ONE row deleted', async () => {
    prisma.attendanceRecord.count.mockResolvedValue(5);
    reopenedPeriod = { id: 'bp-reopened' };
    billing.refinalizePeriod.mockRejectedValue(new Error('snapshot failed'));
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: new Date(Date.now() - 2 * DAY) }),
    ]);

    await service.sweep();

    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(storage.uploadNoticeAttachment).not.toHaveBeenCalled();
  });

  it('archive upload failure → NOT ONE row deleted', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    storage.uploadNoticeAttachment.mockRejectedValue(new Error('minio down'));
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);
    await service.sweep();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mealGuest.deleteMany).not.toHaveBeenCalled();
    expect(prisma.billingLedgerEntry.deleteMany).not.toHaveBeenCalled();
  });

  // ── RET-046/047/019/050/052 explicit financial + boundary proofs ──────────

  it('RET-046: outstanding 750 survives the purge (closing 750 -> opening 750)', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 750 }] },
    };
    // snapshot == next opening == raw truth
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map([['u1', 750]]),
      carriedThrough: '2026-09-30',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
    // The money the next cycle inherits came from the SNAPSHOT, which survives.
    expect(billing.computeOpeningBalances).toHaveBeenCalled();
  });

  it('RET-047/019: settled 0 stays 0 — no historical amount reappears', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
  });

  it('RET-050: snapshot claims 750 but RAW says 0 → snapshot is lying → NO purge', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 750 }] },
    };
    // 1st call = snapshot-preferred opening (750); 2nd = forced RAW (0).
    billing.computeOpeningBalances
      .mockResolvedValueOnce({
        byUser: new Map([['u1', 750]]),
        carriedThrough: '2026-09-30',
      })
      .mockResolvedValueOnce({ byUser: new Map(), carriedThrough: null });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(storage.uploadNoticeAttachment).not.toHaveBeenCalled();
  });

  it('RET-052/012/011: purge is bounded by the FROZEN boundary, never by today', async () => {
    // Boundary was frozen 40 days ago; the sweep only runs now. The cutoff must
    // still be the frozen date — everything after it (the ACTIVE cycle) lives.
    const frozen = new Date(Date.now() - 40 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: frozen,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: frozen }),
    ]);

    await service.sweep();

    for (const table of [
      prisma.attendanceRecord,
      prisma.mealGuest,
      prisma.attendanceCorrectionRequest,
      prisma.billingLedgerEntry,
    ]) {
      const call = table.deleteMany.mock.calls[0];
      if (!call) continue;
      const where = call[0].where;
      const bound =
        where.attendanceDate?.lte ?? where.entryDate?.lte ?? where.endDate?.lte;
      expect(bound).toEqual(frozen); // never "now"
      expect(where.organizationId).toBe('org1'); // RET-038 tenant scope
      expect(where.groupId).toBe('g1');
    }
  });

  // ── RET-042/057 crash-and-retry idempotency ───────────────────────────────

  it('RET-042/057: an interrupted run RESUMES the existing archive, never rebuilds it', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    // A previous run stored the archive but crashed before purging.
    prisma.groupArchive.findFirst.mockResolvedValue({
      id: 'arch-existing',
      purgedAt: null,
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    // No duplicate archive, no wasted MinIO upload...
    expect(prisma.groupArchive.create).not.toHaveBeenCalled();
    expect(storage.uploadNoticeAttachment).not.toHaveBeenCalled();
    // ...but the purge completes and the SAME archive is closed out.
    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
    expect(prisma.groupArchive.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'arch-existing' } }),
    );
  });

  it('RET-042: the boundary advances ONLY after the purge completes', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    // Deletion fails => boundary must NOT move, so the run retries cleanly.
    prisma.attendanceRecord.deleteMany.mockRejectedValue(new Error('db down'));
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    const advanced = prisma.group.updateMany.mock.calls.some(
      (c: any) => c[0]?.data?.retentionPurgeThrough,
    );
    expect(advanced).toBe(false);
  });

  // ── RET-055 history immutability after a cycle-day change ─────────────────

  it('RET-055: a changed cycle day does NOT move an already-frozen boundary', async () => {
    const frozen = new Date('2026-03-31T00:00:00.000Z');
    // Group now runs on the 15th, but its boundary was frozen under the old
    // cycle. The frozen value must win — history is never reinterpreted.
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: frozen, billingCycleStartDay: 15 }),
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(0);
    billing.resolveCurrentPeriod
      .mockReturnValueOnce({ fromDate: '2026-04-01', toDate: '2026-04-14' })
      .mockReturnValueOnce({ fromDate: '2026-04-15', toDate: '2026-05-14' })
      .mockReturnValueOnce({ fromDate: '2026-05-15', toDate: '2026-06-14' });

    await service.sweep();

    // The eligibility probe used the FROZEN date, not a recomputed one.
    expect(prisma.attendanceRecord.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          attendanceDate: { lte: frozen },
        }),
      }),
    );
  });

  // ── RET-056 multi-tenant isolation ────────────────────────────────────────

  it('RET-056: two orgs in one sweep never cross-contaminate', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
      group({
        id: 'g2',
        organizationId: 'org2',
        name: 'Hostel B',
        retentionPurgeThrough: past,
      }),
    ]);

    await service.sweep();

    const scopes = prisma.attendanceRecord.deleteMany.mock.calls.map(
      (c: any) => `${c[0].where.organizationId}/${c[0].where.groupId}`,
    );
    expect(scopes).toEqual(['org1/g1', 'org2/g2']);
    // No delete was ever issued without BOTH scopes present.
    for (const c of prisma.attendanceRecord.deleteMany.mock.calls) {
      expect(c[0].where.organizationId).toBeDefined();
      expect(c[0].where.groupId).toBeDefined();
    }
  });

  it('RET-056: one tenant failing never blocks or leaks into the other', async () => {
    const past = new Date(Date.now() - 2 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    // org1 has no snapshot (blocked); org2 is clean (proceeds).
    prisma.billingPeriod.findFirst.mockImplementation(
      async ({ where }: any) => {
        if (where?.status === 'reopened') return null;
        return where?.organizationId === 'org1'
          ? { periodEnd: past, totalsSnapshot: null }
          : {
              periodEnd: past,
              totalsSnapshot: { members: [{ userId: 'u9', closingBalance: 0 }] },
            };
      },
    );
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
      group({
        id: 'g2',
        organizationId: 'org2',
        name: 'Hostel B',
        retentionPurgeThrough: past,
      }),
    ]);

    await service.sweep();

    const scopes = prisma.attendanceRecord.deleteMany.mock.calls.map(
      (c: any) => `${c[0].where.organizationId}/${c[0].where.groupId}`,
    );
    expect(scopes).toEqual(['org2/g2']); // org1 blocked, org2 unaffected
  });

  // ── RET-045 full lifecycle: creation -> 3 cycles -> purge -> cycle 4 ──────

  it('RET-045: creation → 3 complete cycles → warn → purge → cycle 4 continues', async () => {
    const cycleDay = null; // calendar months
    const g1 = group({ createdAt: new Date('2026-07-01T00:00:00.000Z') });

    // STEP 1 — first sweep freezes the boundary at the end of cycle 3 (Sep 30).
    billing.resolveCurrentPeriod
      .mockReturnValueOnce({ fromDate: '2026-07-01', toDate: '2026-07-31' })
      .mockReturnValueOnce({ fromDate: '2026-08-01', toDate: '2026-08-31' })
      .mockReturnValueOnce({ fromDate: '2026-09-01', toDate: '2026-09-30' });
    prisma.group.findMany.mockResolvedValue([g1]);
    await service.sweep();

    const frozen = prisma.group.updateMany.mock.calls[0][0].data
      .retentionPurgeThrough as Date;
    expect(frozen).toEqual(new Date('2026-09-30T00:00:00.000Z'));
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();

    // STEP 2 — inside cycle 3, within the final 7 days: WARN, delete nothing.
    jest.clearAllMocks();
    prisma.attendanceRecord.count.mockResolvedValue(30); // real data at risk
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: new Date(Date.now() + 3 * DAY) }),
    ]);
    redis.setDedup.mockResolvedValue(true);
    await service.sweep();
    expect(notices.createRequestAlert).toHaveBeenCalledTimes(1);
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();

    // STEP 3 — cycle 3 closed: money carries, archive, purge, advance.
    jest.clearAllMocks();
    const past = new Date(Date.now() - 1 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(42);
    prisma.attendanceRecord.findMany.mockResolvedValue([attendanceRow]);
    prisma.groupArchive.findFirst.mockResolvedValue(null);
    prisma.groupArchive.create.mockResolvedValue({ id: 'arch-cycle3' });
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 750 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map([['u1', 750]]),
      carriedThrough: '2026-09-30',
    });
    billing.resolveCurrentPeriod
      .mockReturnValueOnce({ fromDate: '2026-10-01', toDate: '2026-10-31' })
      .mockReturnValueOnce({ fromDate: '2026-11-01', toDate: '2026-11-30' })
      .mockReturnValueOnce({ fromDate: '2026-12-01', toDate: '2026-12-31' });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past, billingCycleStartDay: cycleDay }),
    ]);

    await service.sweep();

    // archived BEFORE deletion
    expect(storage.uploadNoticeAttachment).toHaveBeenCalled();
    expect(prisma.groupArchive.create).toHaveBeenCalled();
    // purge bounded by the frozen boundary, tenant-scoped
    const del = prisma.attendanceRecord.deleteMany.mock.calls[0][0].where;
    expect(del.attendanceDate.lte).toEqual(past);
    expect(del.organizationId).toBe('org1');
    // cycle 4 inherits the money: opening came from the surviving snapshot
    expect(billing.computeOpeningBalances).toHaveBeenCalled();
    // boundary advanced to the end of the NEXT 3 complete cycles
    const advanced = prisma.group.updateMany.mock.calls
      .map((c: any) => c[0].data.retentionPurgeThrough)
      .filter(Boolean)
      .pop();
    expect(advanced).toEqual(new Date('2026-12-31T00:00:00.000Z'));
    // BillingPeriod rows (locks + snapshots) were never deleted
    expect((prisma.billingPeriod as any).deleteMany).toBeUndefined();
  });

  // ── BR-20/21/22/24/30 stale-membership purge (same lifecycle, no timer) ───

  function memberRows(past: Date, recent: Date) {
    return [
      // blocked before the boundary -> DOOMED
      { id: 'gm1', userId: 'u-blocked', status: 'blocked', blockedAt: past, removedAt: null, updatedAt: past },
      // removed before the boundary -> DOOMED
      { id: 'gm2', userId: 'u-removed', status: 'removed', blockedAt: null, removedAt: past, updatedAt: past },
      // blocked only RECENTLY -> survives (not inactive for the whole window)
      { id: 'gm3', userId: 'u-recent', status: 'blocked', blockedAt: recent, removedAt: null, updatedAt: recent },
      // legacy row, NULL timestamps -> falls back to updatedAt -> DOOMED
      { id: 'gm4', userId: 'u-legacy', status: 'removed', blockedAt: null, removedAt: null, updatedAt: past },
    ];
  }

  it('BR-21: memberships blocked/removed for the whole window are purged with the data', async () => {
    const past = new Date(Date.now() - 40 * DAY);
    const recent = new Date(Date.now() - 1 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    prisma.groupMember.findMany.mockResolvedValue(memberRows(past, recent));
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    const deleted = prisma.groupMember.deleteMany.mock.calls[0][0].where.id.in;
    expect(deleted.sort()).toEqual(['gm1', 'gm2', 'gm4']);
    expect(deleted).not.toContain('gm3'); // recently blocked survives
    // Tenant + group isolation on the candidate scan.
    const scan = prisma.groupMember.findMany.mock.calls[0][0].where;
    expect(scan.groupId).toBe('g1');
    expect(scan.group.organizationId).toBe('org1');
  });

  it('BR-24: an ACTIVE member with a stale blockedAt is NEVER purged', async () => {
    const past = new Date(Date.now() - 40 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = {
      periodEnd: past,
      totalsSnapshot: { members: [{ userId: 'u1', closingBalance: 0 }] },
    };
    billing.computeOpeningBalances.mockResolvedValue({
      byUser: new Map(),
      carriedThrough: '2026-09-30',
    });
    // The trap: blocked -> removed -> rejoined leaves a months-old blockedAt
    // on a perfectly ACTIVE row. STATUS is the gate, so it must not match.
    prisma.groupMember.findMany.mockResolvedValue([]); // status filter excludes it
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    const where = prisma.groupMember.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['blocked', 'removed'] });
    expect(prisma.groupMember.deleteMany).not.toHaveBeenCalled();
  });

  it('BR-21: a low-activity group with nothing to archive STILL cleans memberships', async () => {
    const past = new Date(Date.now() - 40 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(0); // nothing to archive
    prisma.groupMember.findMany.mockResolvedValue(
      memberRows(past, new Date(Date.now() - 1 * DAY)),
    );
    billing.resolveCurrentPeriod.mockReturnValue({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
    });
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    expect(prisma.groupMember.deleteMany).toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('BR-21: a BLOCKED safety gate means memberships are NOT purged either', async () => {
    const past = new Date(Date.now() - 40 * DAY);
    prisma.attendanceRecord.count.mockResolvedValue(5);
    finalizedPeriod = { periodEnd: past, totalsSnapshot: null }; // continuity unprovable
    prisma.groupMember.findMany.mockResolvedValue(
      memberRows(past, new Date(Date.now() - 1 * DAY)),
    );
    prisma.group.findMany.mockResolvedValue([
      group({ retentionPurgeThrough: past }),
    ]);

    await service.sweep();

    expect(prisma.groupMember.deleteMany).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  // ── Misconfiguration corner: a 0/negative cycle count must not purge the
  // cycle still in use. The Math.max(1) floor is the only thing standing
  // between a bad env value and deleting live data.
  it('CORNER: RETENTION_CYCLES=0 is floored to 1 — never purges the active cycle', async () => {
    const module = await Test.createTestingModule({
      providers: [
        RetentionService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: AuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === 'retention.cycles' ? 0 : undefined,
            ),
          },
        },
        { provide: StorageService, useValue: storage },
        { provide: BillingService, useValue: billing },
        { provide: NoticesService, useValue: notices },
        { provide: QueueService, useValue: queue },
      ],
    }).compile();
    const svc = module.get(RetentionService);

    calendarMonthMock();
    const now = new Date();
    prisma.group.findMany.mockResolvedValue([
      group({
        createdAt: new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        ),
      }),
    ]);

    await svc.sweep();

    const boundary = prisma.group.updateMany.mock.calls[0][0].data
      .retentionPurgeThrough as Date;
    // Floored to ONE complete cycle => the end of THIS cycle, and because the
    // adoption guard also applies, never a date that would purge live data.
    expect(boundary.getTime()).toBeGreaterThanOrEqual(Date.now());
    const dayAfter = new Date(boundary.getTime() + DAY);
    expect(dayAfter.getUTCDate()).toBe(1); // still a real cycle end
  });

  it('attendance-only group (no pricing) skips finalize AND the money gate', async () => {
    prisma.attendanceRecord.count.mockResolvedValue(5);
    prisma.group.findMany.mockResolvedValue([
      group({
        retentionPurgeThrough: new Date(Date.now() - 2 * DAY),
        mealPricingEnabled: false,
      }),
    ]);
    await service.sweep();
    expect(billing.finalizePeriod).not.toHaveBeenCalled();
    expect(billing.computeOpeningBalances).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
  });
  // ── Live-Test-17 — RETENTION AUTHORITY TRANSITION ─────────────────────────
  //
  // "Attendance-Only calendar retention governs until the first successful Meal
  //  schedule publication. At that publication the reviewed Billing Cycle
  //  becomes the authoritative retention calendar."
  //
  // These use the REAL BillingService.resolveCurrentPeriod (the production
  // calendar engine) instead of the fixed harness mock — re-implementing the
  // cycle arithmetic inside the test would prove nothing about production.
  describe('retention authority transition (AO -> billing cycle)', () => {
    const realPeriod = (todayStr: string, cycleStartDay: number | null) =>
      (BillingService.prototype as any).resolveCurrentPeriod.call(
        null,
        todayStr,
        cycleStartDay,
      );

    beforeEach(() => {
      billing.resolveCurrentPeriod.mockImplementation(realPeriod);
      jest.useFakeTimers().setSystemTime(new Date('2026-01-16T06:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    it('LT17-RET-01: the canonical 01 Jan -> 14 Apr scenario', async () => {
      // AO group created 01 Jan froze its boundary at 31 Mar (3 calendar
      // months). It published its first schedule on 15 Jan with cycle day 15,
      // so the authoritative lifecycle is 15 Jan -> 14 Apr (three COMPLETE
      // cycles: 15 Jan-14 Feb, 15 Feb-14 Mar, 15 Mar-14 Apr).
      prisma.group.findMany.mockResolvedValue([
        group({
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          billingCycleStartDay: 15,
          retentionPurgeThrough: new Date('2026-03-31T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2026-01-15T00:00:00.000Z'),
          retentionAnchoredAt: null,
        }),
      ]);

      await service.sweep();

      const data = prisma.group.updateMany.mock.calls[0][0].data;
      expect(fmt(data.retentionPurgeThrough)).toBe('2026-04-14');
      expect(data.retentionAnchoredAt).toBeInstanceOf(Date);
      // The obsolete 31 Mar AO event is superseded, and NOTHING destructive
      // happens during the handover.
      expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
      expect(prisma.groupArchive.create).not.toHaveBeenCalled();
    });

    it('LT17-RET-02: the transition runs EXACTLY ONCE (boundary stays frozen)', async () => {
      // Already transitioned: the marker must stop it re-running, or the
      // frozen-boundary guarantee (active cycle unpurgeable) is destroyed.
      prisma.group.findMany.mockResolvedValue([
        group({
          billingCycleStartDay: 15,
          retentionPurgeThrough: new Date('2026-04-14T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2026-01-15T00:00:00.000Z'),
          retentionAnchoredAt: new Date('2026-01-16T00:00:00.000Z'),
        }),
      ]);

      await service.sweep();

      const reAnchored = prisma.group.updateMany.mock.calls.some(
        (c: any) => c[0]?.data?.retentionAnchoredAt !== undefined,
      );
      expect(reAnchored).toBe(false);
    });

    it('LT17-RET-03: ON -> publish -> OFF -> ON cannot restart the lifecycle', async () => {
      // Meals turned OFF after publishing. `firstSchedulePublishedAt` is
      // monotonic and never cleared, and the group is already anchored — so no
      // second transition, no restored AO clock, no new 3-cycle countdown.
      prisma.group.findMany.mockResolvedValue([
        group({
          mealPricingEnabled: false, // meals/pricing toggled off afterwards
          billingCycleStartDay: 15,
          retentionPurgeThrough: new Date('2026-04-14T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2026-01-15T00:00:00.000Z'),
          retentionAnchoredAt: new Date('2026-01-16T00:00:00.000Z'),
        }),
      ]);

      await service.sweep();

      const touched = prisma.group.updateMany.mock.calls.some(
        (c: any) => c[0]?.data?.retentionPurgeThrough !== undefined,
      );
      expect(touched).toBe(false);
    });

    it('LT17-RET-04: a DRAFT group keeps its Attendance-Only boundary', async () => {
      // Meals ON, cycle configured, but never published: toggling meals on is
      // NOT a financial lifecycle, so the AO clock stays authoritative.
      prisma.group.findMany.mockResolvedValue([
        group({
          billingCycleStartDay: 15,
          retentionPurgeThrough: new Date('2026-03-31T00:00:00.000Z'),
          firstSchedulePublishedAt: null,
          retentionAnchoredAt: null,
        }),
      ]);

      await service.sweep();

      const touched = prisma.group.updateMany.mock.calls.some(
        (c: any) => c[0]?.data?.retentionAnchoredAt !== undefined,
      );
      expect(touched).toBe(false);
    });

    it('LT17-RET-05: adoption never causes a zero-notice purge', async () => {
      // A group published long ago: the naive boundary lands in the PAST. The
      // existing adoption guard must walk it forward whole cycles until the
      // mandatory advance-warning window fits, so raw data is never destroyed
      // the moment this feature is deployed.
      prisma.group.findMany.mockResolvedValue([
        group({
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
          billingCycleStartDay: 15,
          retentionPurgeThrough: new Date('2025-03-31T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2025-01-15T00:00:00.000Z'),
          retentionAnchoredAt: null,
        }),
      ]);

      await service.sweep();

      const boundary = prisma.group.updateMany.mock.calls[0][0].data
        .retentionPurgeThrough as Date;
      const minBoundary = new Date(Date.now() + 7 * DAY);
      expect(boundary.getTime()).toBeGreaterThanOrEqual(minBoundary.getTime());
      // Still a REAL cycle end: the day after it must be the anchor day.
      expect(new Date(boundary.getTime() + DAY).getUTCDate()).toBe(15);
      expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    });

    it('BOUNDARY: cycle day 31 clamps through short months (Feb) via the real engine', async () => {
      // Anchor-31 published 31 Jan. resolveCurrentPeriod clamps the effective
      // anchor to each month's last day, so the three cycles must still be
      // contiguous and land on a real cycle end — no gap, no overlap.
      prisma.group.findMany.mockResolvedValue([
        group({
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          billingCycleStartDay: 31,
          retentionPurgeThrough: new Date('2026-03-31T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2026-01-31T00:00:00.000Z'),
          retentionAnchoredAt: null,
        }),
      ]);

      await service.sweep();

      const boundary = prisma.group.updateMany.mock.calls[0][0].data
        .retentionPurgeThrough as Date;
      // The day AFTER the boundary must be the next effective anchor — i.e. the
      // clamped 31st of that month (28/29/30/31), never an arbitrary date.
      const next = new Date(boundary.getTime() + DAY);
      const lastDayOfNextMonth = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
      ).getUTCDate();
      expect(next.getUTCDate()).toBe(Math.min(31, lastDayOfNextMonth));
    });

    it('BOUNDARY: cycle day 1 behaves identically to null (calendar month)', async () => {
      const run = async (cycleDay: number | null) => {
        prisma.group.updateMany.mockClear();
        prisma.group.findMany.mockResolvedValue([
          group({
            billingCycleStartDay: cycleDay,
            retentionPurgeThrough: new Date('2026-03-31T00:00:00.000Z'),
            firstSchedulePublishedAt: new Date('2026-01-15T00:00:00.000Z'),
            retentionAnchoredAt: null,
          }),
        ]);
        await service.sweep();
        return fmt(
          prisma.group.updateMany.mock.calls[0][0].data.retentionPurgeThrough,
        );
      };
      expect(await run(1)).toBe(await run(null));
    });

    it('MULTI-TENANT: two groups in different orgs each get their OWN boundary', async () => {
      prisma.group.findMany.mockResolvedValue([
        group({
          id: 'gA',
          organizationId: 'orgA',
          billingCycleStartDay: 15,
          retentionPurgeThrough: new Date('2026-03-31T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2026-01-15T00:00:00.000Z'),
          retentionAnchoredAt: null,
        }),
        group({
          id: 'gB',
          organizationId: 'orgB',
          billingCycleStartDay: 5,
          retentionPurgeThrough: new Date('2026-03-31T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2026-01-05T00:00:00.000Z'),
          retentionAnchoredAt: null,
        }),
      ]);

      await service.sweep();

      const calls = prisma.group.updateMany.mock.calls;
      expect(calls).toHaveLength(2);
      // Each write targets its OWN group id — no cross-group overwrite.
      expect(calls[0][0].where.id).toBe('gA');
      expect(calls[1][0].where.id).toBe('gB');
      // Tenant check is atomic in the WHERE — a group can only ever be
      // re-anchored within its OWN organization.
      expect(calls[0][0].where.organizationId).toBe('orgA');
      expect(calls[1][0].where.organizationId).toBe('orgB');
      // ...and the boundaries differ, proving each used its own cycle day.
      expect(fmt(calls[0][0].data.retentionPurgeThrough)).not.toBe(
        fmt(calls[1][0].data.retentionPurgeThrough),
      );
    });

    it('FAIL-CLOSED: after transition, a failed continuity gate still blocks the purge', async () => {
      // The transition must not weaken any existing destructive-path safeguard.
      jest.useRealTimers();
      prisma.attendanceRecord.count.mockResolvedValue(5);
      finalizedPeriod = {
        id: 'bp1',
        periodEnd: new Date(Date.now() + 5 * DAY),
        totalsSnapshot: null, // missing snapshot => continuity cannot be proven
      };
      prisma.group.findMany.mockResolvedValue([
        group({
          billingCycleStartDay: 15,
          retentionPurgeThrough: new Date(Date.now() - 2 * DAY),
          firstSchedulePublishedAt: new Date('2026-01-15T00:00:00.000Z'),
          retentionAnchoredAt: new Date('2026-01-16T00:00:00.000Z'), // already transitioned
        }),
      ]);

      await service.sweep();

      expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    });

    it('LT17-RET-06: a calendar-month group (no cycle day) transitions too', async () => {
      // Meals published but the admin never set a cycle day -> calendar month
      // remains the calendar, anchored from the PUBLISH date, not createdAt.
      prisma.group.findMany.mockResolvedValue([
        group({
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          billingCycleStartDay: null,
          retentionPurgeThrough: new Date('2026-03-31T00:00:00.000Z'),
          firstSchedulePublishedAt: new Date('2026-01-15T00:00:00.000Z'),
          retentionAnchoredAt: null,
        }),
      ]);

      await service.sweep();

      const boundary = prisma.group.updateMany.mock.calls[0][0].data
        .retentionPurgeThrough as Date;
      // Jan + Feb + Mar complete calendar months from the publish month.
      expect(fmt(boundary)).toBe('2026-03-31');
      expect(new Date(boundary.getTime() + DAY).getUTCDate()).toBe(1);
    });
  });
});
