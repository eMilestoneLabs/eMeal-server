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
 * SRS Module 03 RET-001..015 — rolling billing-aware 3-month retention.
 *
 * Invariants proven here:
 *   • RET-013 first touch only bootstraps the rolling pointer (no purge);
 *   • Phase 1 — nothing happens before retentionReviewAt;
 *   • RET-012 no eligible rows → review rolls forward, nothing deleted;
 *   • RET-005/006 unsettled bill inside the reminder+grace window → daily
 *     reminder only, never a purge;
 *   • RET-007 past the deadline → auto-finalize, then archive + purge;
 *   • RET-009 archive upload failure → NOT ONE row is deleted.
 */
describe('RetentionService (RET-001..015)', () => {
  let service: RetentionService;
  let prisma: any;
  let storage: { uploadNoticeAttachment: jest.Mock };
  let billing: {
    resolveCurrentPeriod: jest.Mock;
    finalizePeriod: jest.Mock;
    bumpBillingVersion: jest.Mock;
  };
  let notices: { createRequestAlert: jest.Mock };
  let redis: { setDedup: jest.Mock };
  let audit: { log: jest.Mock };
  let queue: { enqueueBatchPush: jest.Mock };

  const DAY = 24 * 60 * 60 * 1000;

  // Per-test billing-period fixtures (routed by status in the prisma mock).
  let finalizedPeriod: { periodEnd: Date } | null;
  let reopenedPeriod: { id: string } | null;

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
        // Two distinct probes share findFirst — the latest FINALIZED period
        // and the RET-003 reopened-overlap guard. Route by where.status.
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          where?.status === 'reopened' ? reopenedPeriod : finalizedPeriod,
        ),
        findMany: jest.fn().mockResolvedValue([]),
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
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'arch1',
          ...data,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    storage = {
      uploadNoticeAttachment: jest
        .fn()
        .mockResolvedValue('https://cdn.example/archive.xlsx'),
    };
    billing = {
      resolveCurrentPeriod: jest.fn().mockReturnValue({
        fromDate: '2026-07-01',
        toDate: '2026-07-31',
      }),
      finalizePeriod: jest.fn().mockResolvedValue({ id: 'bp1' }),
      bumpBillingVersion: jest.fn().mockResolvedValue(undefined),
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

  it('RET-013: first touch bootstraps retentionReviewAt and does nothing else', async () => {
    prisma.group.findMany.mockResolvedValue([group()]);

    await service.sweep();

    expect(prisma.group.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'g1' },
        data: { retentionReviewAt: expect.any(Date) },
      }),
    );
    expect(prisma.attendanceRecord.count).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('Phase 1: not due yet → untouched', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() + 30 * DAY) }),
    ]);

    await service.sweep();

    expect(prisma.group.updateMany).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(notices.createRequestAlert).not.toHaveBeenCalled();
  });

  it('RET-012: due but no eligible rows → review rolls forward, no purge', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() - DAY) }),
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(0);

    await service.sweep();

    expect(prisma.group.updateMany).toHaveBeenCalled(); // reschedule
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(storage.uploadNoticeAttachment).not.toHaveBeenCalled();
  });

  it('RET-005/006: unsettled bill inside reminder+grace window → reminder only', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() - DAY) }), // deadline = +9d
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(40);
    // finalizedPeriod stays null — the bill was never finalized.

    await service.sweep();

    expect(notices.createRequestAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Quarterly Data Retention Reminder',
        groupId: 'g1',
      }),
    );
    expect(billing.finalizePeriod).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('reminder is deduped to once per day (redis flag)', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() - DAY) }),
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(40);
    redis.setDedup.mockResolvedValue(false); // already sent today

    await service.sweep();

    expect(notices.createRequestAlert).not.toHaveBeenCalled();
  });

  it('RET-007/008/011: past deadline → auto-finalize, archive, purge, reschedule', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() - 20 * DAY) }),
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(40);
    // finalizedPeriod stays null — outstanding span must be auto-finalized.

    await service.sweep();

    // Step 1/2 — auto-finalize the outstanding span (RET-007).
    expect(billing.finalizePeriod).toHaveBeenCalledWith(
      'admin1',
      'org1',
      expect.objectContaining({ groupId: 'g1' }),
    );
    // Step 4/5 — Excel (+ optional PDF) stored in MinIO BEFORE any delete.
    expect(storage.uploadNoticeAttachment).toHaveBeenCalled();
    expect(prisma.groupArchive.create).toHaveBeenCalled();
    // Step 6 — every admin notified (bell), exact SRS wording family.
    expect(notices.createRequestAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Archive Ready' }),
    );
    // Step 7 — purge.
    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
    expect(prisma.mealGuest.deleteMany).toHaveBeenCalled();
    // Step 8/RET-012 — next review scheduled, billing caches invalidated.
    expect(prisma.group.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { retentionReviewAt: expect.any(Date) },
      }),
    );
    expect(billing.bumpBillingVersion).toHaveBeenCalledWith('g1');
    expect(audit.log).toHaveBeenCalled();
  });

  it('settled bill → archives without waiting for the reminder window', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() - DAY) }),
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(40);
    // Finalized through (and past) the cutoff — nothing outstanding.
    finalizedPeriod = { periodEnd: new Date('2026-06-30T00:00:00.000Z') };

    await service.sweep();

    expect(billing.finalizePeriod).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
  });

  it('RET-003: REOPENED period overlapping the cutoff → reminder only, never purged', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() - 20 * DAY) }), // even past deadline
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(40);
    finalizedPeriod = { periodEnd: new Date('2026-06-30T00:00:00.000Z') };
    reopenedPeriod = { id: 'bp-reopened' }; // admin is actively editing an old bill

    await service.sweep();

    expect(notices.createRequestAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Quarterly Data Retention Reminder' }),
    );
    expect(billing.finalizePeriod).not.toHaveBeenCalled();
    expect(storage.uploadNoticeAttachment).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('RET-009: archive upload failure → NOT ONE row deleted', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({ retentionReviewAt: new Date(Date.now() - DAY) }),
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(40);
    finalizedPeriod = { periodEnd: new Date('2026-06-30T00:00:00.000Z') };
    storage.uploadNoticeAttachment.mockRejectedValue(new Error('minio down'));

    await service.sweep(); // per-group failure is contained, never thrown

    expect(prisma.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mealGuest.deleteMany).not.toHaveBeenCalled();
    expect(prisma.notice.deleteMany).not.toHaveBeenCalled();
    expect(prisma.groupArchive.create).not.toHaveBeenCalled();
  });

  it('attendance-only groups (no pricing) skip finalize and archive at deadline', async () => {
    prisma.group.findMany.mockResolvedValue([
      group({
        retentionReviewAt: new Date(Date.now() - DAY),
        mealPricingEnabled: false,
      }),
    ]);
    prisma.attendanceRecord.count.mockResolvedValue(40);

    await service.sweep();

    expect(billing.finalizePeriod).not.toHaveBeenCalled();
    expect(prisma.billingPeriod.findFirst).not.toHaveBeenCalled();
    expect(prisma.attendanceRecord.deleteMany).toHaveBeenCalled();
  });
});
