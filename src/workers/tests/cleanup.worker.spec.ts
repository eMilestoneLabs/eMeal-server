/**
 * cleanup.worker.spec.ts — B6 Phase
 *
 * Unit tests for CleanupWorker.
 * Verifies: deduplication, org isolation in queries, stale token logic.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CleanupWorker } from '../cleanup.worker';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { JOB_TYPES } from '../../queue/constants/queue.constants';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: { updateMany: jest.fn() },
  otpRequest: { deleteMany: jest.fn() },
  event: { updateMany: jest.fn() },
  groupMember: { deleteMany: jest.fn() },
  auditLog: { deleteMany: jest.fn() },
};

const mockRedis = {
  setDedup: jest.fn(),
};

function makeJob(name: string, data: Record<string, unknown>) {
  return { id: 'test-job-1', name, data } as any;
}

describe('CleanupWorker', () => {
  let worker: CleanupWorker;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CleanupWorker,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    worker = module.get<CleanupWorker>(CleanupWorker);
    jest.clearAllMocks();
  });

  // ── Stale token cleanup ─────────────────────────────────────────────────────

  it('stale-tokens cleanup: scopes updateMany to organizationId', async () => {
    mockRedis.setDedup.mockResolvedValueOnce(true); // not previously run
    mockPrisma.user.updateMany.mockResolvedValueOnce({ count: 5 });
    mockPrisma.otpRequest.deleteMany.mockResolvedValueOnce({ count: 2 });

    const job = makeJob(JOB_TYPES.CLEANUP_STALE_TOKENS, {
      organizationId: 'org-1',
      olderThanDays: 30,
      dedupKey: 'test-dedup',
      enqueuedAt: new Date().toISOString(),
    });

    await worker.process(job);

    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
      }),
    );
  });

  it('stale-tokens cleanup: skips when already run (dedup)', async () => {
    mockRedis.setDedup.mockResolvedValueOnce(false); // already ran

    const job = makeJob(JOB_TYPES.CLEANUP_STALE_TOKENS, {
      organizationId: 'org-1',
      olderThanDays: 30,
      dedupKey: 'already-ran',
      enqueuedAt: new Date().toISOString(),
    });

    await worker.process(job);

    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('throws if organizationId is missing', async () => {
    const job = makeJob(JOB_TYPES.CLEANUP_STALE_TOKENS, {
      organizationId: '',
      olderThanDays: 30,
      dedupKey: 'x',
      enqueuedAt: new Date().toISOString(),
    });

    await expect(worker.process(job)).rejects.toThrow('Missing organizationId');
  });

  // ── Expired event cleanup ───────────────────────────────────────────────────

  it('expired-events cleanup: only deactivates events in the given org', async () => {
    mockRedis.setDedup.mockResolvedValueOnce(true);
    mockPrisma.event.updateMany.mockResolvedValueOnce({ count: 3 });

    const job = makeJob(JOB_TYPES.CLEANUP_EXPIRED_EVENTS, {
      organizationId: 'org-1',
      cutoffDate: '2026-05-01T00:00:00.000Z',
      dedupKey: 'expired-events-dedup',
      enqueuedAt: new Date().toISOString(),
    });

    await worker.process(job);

    expect(mockPrisma.event.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
        data: { isActive: false },
      }),
    );
  });

  // ── Audit log cleanup ───────────────────────────────────────────────────────

  it('audit-logs cleanup: scopes deleteMany to organizationId', async () => {
    mockRedis.setDedup.mockResolvedValueOnce(true);
    mockPrisma.auditLog.deleteMany.mockResolvedValueOnce({ count: 100 });

    const job = makeJob(JOB_TYPES.CLEANUP_AUDIT_LOGS, {
      organizationId: 'org-2',
      olderThanDays: 90,
      dedupKey: 'audit-cleanup-dedup',
      enqueuedAt: new Date().toISOString(),
    });

    await worker.process(job);

    expect(mockPrisma.auditLog.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-2' }),
      }),
    );
  });
});
