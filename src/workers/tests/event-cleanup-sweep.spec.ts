/**
 * Pass 14 (FR-EVT-054) — the expired-event cleanup FAN-OUT. The per-org
 * cleanup job existed since Phase B but had no caller; this sweep is what
 * makes deactivation + the 7-day hard-purge actually fire in production.
 */
import { SystemDefaultWorker } from '../system-default.worker';
import { JOB_TYPES } from '../../queue/constants/queue.constants';

describe('Pass 14 — event-cleanup sweep fan-out', () => {
  function makeWorker(orgs: string[], enqueue: jest.Mock) {
    const prisma: any = {
      event: {
        findMany: jest
          .fn()
          .mockResolvedValue(orgs.map((organizationId) => ({ organizationId }))),
      },
    };
    const queue: any = { enqueueExpiredEventCleanup: enqueue };
    return new SystemDefaultWorker(
      prisma,
      {} as any,
      queue,
      {} as any,
      {} as any,
    );
  }

  it('enqueues one per-org cleanup with a date-only (day-deduped) cutoff', async () => {
    const enqueue = jest.fn().mockResolvedValue('job1');
    const worker = makeWorker(['org1', 'org2'], enqueue);

    await worker.process({ name: JOB_TYPES.EVENT_CLEANUP_SWEEP } as any);

    expect(enqueue).toHaveBeenCalledTimes(2);
    const payload = enqueue.mock.calls[0][0];
    expect(payload.organizationId).toBe('org1');
    // Date-only cutoff → jobId dedupes to one cleanup per org per UTC day.
    expect(payload.cutoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('one org failing does not starve the rest', async () => {
    const enqueue = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue('job2');
    const worker = makeWorker(['org1', 'org2', 'org3'], enqueue);

    await expect(
      worker.process({ name: JOB_TYPES.EVENT_CLEANUP_SWEEP } as any),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
});
