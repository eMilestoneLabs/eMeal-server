/**
 * Pass 15 (FR-NOTX-010) — the two new notification triggers:
 *   • weekly attendance summary digest (once per group per digest day);
 *   • attendance-reminder SCHEDULING sweep — the 30/10-min pre-close
 *     dispatch producer had no caller since B6, so reminders never fired.
 */
import { SystemDefaultWorker } from '../system-default.worker';
import { JOB_TYPES } from '../../queue/constants/queue.constants';

jest.mock('../../common/utils/date.utils', () => ({
  ...jest.requireActual('../../common/utils/date.utils'),
  // Frozen org-local clock: 08:00 keeps the digest hour gate open and puts a
  // 10:00 window close exactly 120 minutes out for the reminder sweep.
  getCurrentTimeInTimezone: jest.fn(() => '08:00'),
}));

// Weekday (UTC calendar) of the real "today" — the digest tests pin the
// configured digest day to it so the gate passes deterministically.
const TODAY_DOW = new Date().getUTCDay();

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'attendance.weeklyDigestDay': TODAY_DOW,
    'attendance.weeklyDigestHour': 0,
    ...overrides,
  };
  return {
    get: jest.fn((key: string, def: unknown) => values[key] ?? def),
  } as any;
}

describe('Pass 15 — weekly digest sweep', () => {
  function makeWorker(opts: {
    dedupFree: boolean;
    statusRows?: Array<{ status: string; _count: { _all: number } }>;
  }) {
    const prisma: any = {
      group: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'g1',
            name: 'Office System',
            organizationId: 'org1',
            organization: { timezone: 'UTC' },
          },
        ]),
      },
      attendanceRecord: {
        groupBy: jest.fn().mockResolvedValue(
          opts.statusRows ?? [
            { status: 'present', _count: { _all: 10 } },
            { status: 'absent', _count: { _all: 2 } },
          ],
        ),
      },
      groupMember: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: 'u1', user: { fcmToken: 'tok1' } }]),
      },
    };
    const redis: any = { setDedup: jest.fn().mockResolvedValue(opts.dedupFree) };
    const queue: any = { enqueueBatchPush: jest.fn().mockResolvedValue('j1') };
    const worker = new SystemDefaultWorker(
      prisma,
      redis,
      queue,
      {} as any,
      makeConfig(),
    );
    return { worker, queue, redis };
  }

  it('pushes an aggregate 7-day summary to consented members', async () => {
    const { worker, queue } = makeWorker({ dedupFree: true });

    await worker.process({ name: JOB_TYPES.WEEKLY_DIGEST_SWEEP } as any);

    expect(queue.enqueueBatchPush).toHaveBeenCalledTimes(1);
    const payload = queue.enqueueBatchPush.mock.calls[0][0];
    expect(payload.organizationId).toBe('org1');
    expect(payload.recipients).toEqual([{ userId: 'u1', fcmToken: 'tok1' }]);
    // Aggregate counts only — no member names, no amounts (FR-NOTX-017).
    expect(payload.body).toContain('10 present');
    expect(payload.body).toContain('83%'); // 10 / 12
    expect(payload.data.type).toBe('weekly_digest');
  });

  it('the once-flag caps the digest at one dispatch per digest day', async () => {
    const { worker, queue } = makeWorker({ dedupFree: false });

    await worker.process({ name: JOB_TYPES.WEEKLY_DIGEST_SWEEP } as any);

    expect(queue.enqueueBatchPush).not.toHaveBeenCalled();
  });

  it('an empty week stays quiet (no digest about nothing)', async () => {
    const { worker, queue } = makeWorker({ dedupFree: true, statusRows: [] });

    await worker.process({ name: JOB_TYPES.WEEKLY_DIGEST_SWEEP } as any);

    expect(queue.enqueueBatchPush).not.toHaveBeenCalled();
  });
});

describe('Pass 15 — attendance reminder scheduling sweep', () => {
  function makeWorker(opts: {
    close: string | null;
    entries?: Array<{ mealId: string; openTime: string; closeTime: string }>;
    planner?: boolean;
  }) {
    const prisma: any = {
      group: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'g1',
            organizationId: 'org1',
            mealsEnabled: true,
            weeklyMenuEnabled: opts.planner === true,
            dayWiseMealsEnabled: false,
            organization: { timezone: 'UTC' },
          },
        ]),
      },
      meal: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            slotKey: 'lunch',
            isActive: true,
            attendanceWindowClose: opts.close,
          },
        ]),
      },
      // Live-Test-9 ISSUE-003: sweeps now read the PUBLISHED-day snapshot via
      // mealSchedule (published-day.util), not live scheduleEntry rows. The
      // mocked row carries today's entries in its frozen publishedSnapshot.
      mealSchedule: {
        findFirst: jest.fn().mockResolvedValue(
          (opts.entries ?? []).length > 0
            ? {
                publishedSnapshot: (opts.entries ?? []).map((e) => ({
                  ...e,
                  date: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
                })),
              }
            : null,
        ),
      },
    };
    const queue: any = {
      scheduleAttendanceReminder: jest.fn().mockResolvedValue('j1'),
    };
    const worker = new SystemDefaultWorker(
      prisma,
      {} as any,
      queue,
      {} as any,
      makeConfig(),
    );
    return { worker, queue };
  }

  it('enqueues the 30- and 10-minute pre-close reminders for an open window', async () => {
    // Frozen clock 08:00, close 10:00 → 120 minutes out.
    const { worker, queue } = makeWorker({ close: '10:00' });

    await worker.process({ name: JOB_TYPES.REMINDER_SCHEDULE_SWEEP } as any);

    expect(queue.scheduleAttendanceReminder).toHaveBeenCalledTimes(2);
    const offsets = queue.scheduleAttendanceReminder.mock.calls.map(
      (c: any[]) => c[0].minutesBefore,
    );
    expect(offsets).toEqual([30, 10]);
    // Delays land at close-30min (90min) and close-10min (110min).
    const delays = queue.scheduleAttendanceReminder.mock.calls.map(
      (c: any[]) => Math.round(c[1] / 60_000),
    );
    expect(delays).toEqual([90, 110]);
  });

  it('an already-closed window schedules nothing (fail-safe)', async () => {
    const { worker, queue } = makeWorker({ close: '07:00' });

    await worker.process({ name: JOB_TYPES.REMINDER_SCHEDULE_SWEEP } as any);

    expect(queue.scheduleAttendanceReminder).not.toHaveBeenCalled();
  });

  it('planner-mode holiday (no published entry today) schedules nothing', async () => {
    const { worker, queue } = makeWorker({ close: '10:00', planner: true });

    await worker.process({ name: JOB_TYPES.REMINDER_SCHEDULE_SWEEP } as any);

    expect(queue.scheduleAttendanceReminder).not.toHaveBeenCalled();
  });
});
