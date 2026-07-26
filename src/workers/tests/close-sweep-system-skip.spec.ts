/**
 * Live-Test-14 ISSUE-004 — the close-time sweep's System SKIP contract.
 *
 * This is the highest-blast-radius change of the batch (it now touches EVERY
 * active group and writes rows the billing engine reads), and it had no test at
 * all. These cases pin the USER-LOCKED business rules in executable form:
 *
 *   • an ordinary group's non-responder gets the EXISTING System SKIP, and it is
 *     BILLING-NEUTRAL (price null ⇒ ₹0 in every money path);
 *   • a Bill-Skip group's System SKIP carries its price snapshot and bills by the
 *     existing rules;
 *   • an opt-out group still writes PRESENT, and the FR-TRUST-003 fair-opportunity
 *     floor + reminder gates still protect that claim;
 *   • those two gates do NOT gate the System SKIP — a non-responder always
 *     leaves Pending.
 *
 * No new status is asserted anywhere: only 'present' and the pre-existing
 * 'skipped'.
 */
import { SystemDefaultWorker } from '../system-default.worker';
import { JOB_TYPES } from '../../queue/constants/queue.constants';

jest.mock('../../common/utils/date.utils', () => ({
  ...jest.requireActual('../../common/utils/date.utils'),
  // Frozen org-local clock well past a 09:00–10:00 window, so it reads CLOSED.
  getCurrentTimeInTimezone: jest.fn(() => '18:00'),
}));

type GroupOverrides = {
  attendanceDefault?: string;
  billSkippedMeals?: boolean;
  mealsEnabled?: boolean;
  /** Planner mode — the published-day entry then governs the day. */
  weeklyMenuEnabled?: boolean;
};

type Opts = {
  reminderDispatched?: boolean;
  windowOpen?: string;
  windowClose?: string;
  /** Archived meal (isActive:false). */
  mealActive?: boolean;
  /** No group rows at all. */
  noGroups?: boolean;
  /** Group has no attendance-enabled meals. */
  noMeals?: boolean;
  /** The member already responded — a record exists for the meal/date. */
  alreadyMarked?: boolean;
  /** The member is on vacation for the day. */
  onVacation?: boolean;
};

function makeWorker(group: GroupOverrides = {}, opts: Opts = {}) {
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const groupRow = {
    id: 'grp_01',
    organizationId: 'org_01',
    attendanceDefault: group.attendanceDefault ?? 'absent',
    billSkippedMeals: group.billSkippedMeals ?? false,
    attendanceGraceMinutes: 0,
    minOptOutMinutes: null,
    mealsEnabled: group.mealsEnabled ?? true,
    weeklyMenuEnabled: group.weeklyMenuEnabled ?? false,
    dayWiseMealsEnabled: false,
    organization: { timezone: 'Asia/Kolkata' },
  };
  const prisma: any = {
    group: {
      // The mock HONOURS the `where` clause. A mock that ignored it would keep
      // every case green even if someone reinstated the original ISSUE-004 bug
      // (`OR: [attendanceDefault='present', billSkippedMeals]`, which excluded
      // ordinary groups from the sweep) — verified by mutation: with a
      // pass-through mock that regression was undetectable.
      findMany: jest.fn(async ({ where }: any = {}) => {
        if (where?.isActive === true && groupRow.mealsEnabled === undefined) {
          return [];
        }
        if (Array.isArray(where?.OR)) {
          const matches = where.OR.some((clause: any) =>
            Object.entries(clause).every(
              ([k, v]) => (groupRow as any)[k] === v,
            ),
          );
          if (!matches) return [];
        }
        return opts.noGroups ? [] : [groupRow];
      }),
    },
    meal: {
      findMany: jest.fn().mockResolvedValue(
        opts.noMeals
          ? []
          : [
              {
                id: 'meal_01',
                name: 'Lunch',
                slotKey: 'lunch',
                isActive: opts.mealActive ?? true,
                preferencesEnabled: false,
                // 09:00–10:00 is fully closed at the frozen 18:00 clock, and its
                // 60-minute span clears the default 30-minute opt-out floor.
                // `null` models a meal with no bounded window.
                attendanceWindowOpen:
                  opts.windowOpen === undefined ? '09:00' : opts.windowOpen,
                attendanceWindowClose:
                  opts.windowClose === undefined ? '10:00' : opts.windowClose,
                price: 60,
              },
            ],
      ),
    },
    // No published schedule — master-mode group.
    mealSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
    mealPreferenceGroup: { findMany: jest.fn().mockResolvedValue([]) },
    // Nobody on vacation.
    vacationRequest: { findMany: jest.fn().mockResolvedValue([]) },
    groupMember: {
      findMany: jest.fn().mockResolvedValue([
        {
          userId: 'usr_member',
          user: {
            remindersEnabled: true,
            fcmToken: null,
            isVacationMode: opts.onVacation === true,
          },
        },
      ]),
    },
    attendanceRecord: {
      // First call = existing records for the meal/date (none → the member is a
      // non-responder). Second call = the rows just created, read back for audit.
      findMany: jest
        .fn()
        .mockResolvedValueOnce(
          opts.alreadyMarked ? [{ userId: 'usr_member' }] : [],
        )
        .mockResolvedValue([{ id: 'att_01', userId: 'usr_member' }]),
      createMany,
    },
  };
  const redis: any = {
    setDedup: jest.fn().mockResolvedValue(true),
    // Reminder dispatch flag — off by default so the gate is exercised.
    exists: jest.fn().mockResolvedValue(opts.reminderDispatched === true),
    del: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue('OK'),
  };
  const config: any = {
    get: jest.fn((key: string, fallback?: unknown) => fallback),
  };
  const worker = new SystemDefaultWorker(
    prisma,
    redis,
    {} as any,
    { log: jest.fn() } as any,
    config,
  );
  return { worker, createMany, prisma };
}

const run = (worker: SystemDefaultWorker) =>
  worker.process({ name: JOB_TYPES.SYSTEM_DEFAULT_SWEEP } as any);

/** The single row the sweep wrote (fails loudly if it wrote none). */
function writtenRow(createMany: jest.Mock) {
  expect(createMany).toHaveBeenCalledTimes(1);
  const rows = createMany.mock.calls[0][0].data;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('ISSUE-004 — close sweep assigns the existing System SKIP', () => {
  it('ORDINARY group: non-responder gets a ₹0 System SKIP (Skip Billed = OFF)', async () => {
    const { worker, createMany } = makeWorker({ billSkippedMeals: false });

    await run(worker);

    const row = writtenRow(createMany);
    expect(row.status).toBe('skipped');
    expect(row.source).toBe('system_default');
    // THE billing rule: Skip Billed OFF ⇒ no billing whatsoever.
    expect(row.price).toBeNull();
  });

  it('the SKIP is written even though no reminder was dispatched', async () => {
    // The FR-TRUST-003 reminder gate protects the auto-PRESENT claim. It must not
    // hold a member in Pending, or "unmarked ⇒ Skip" would depend on push
    // delivery — the exact symptom ISSUE-004 reported.
    const { worker, createMany } = makeWorker(
      { billSkippedMeals: false },
      { reminderDispatched: false },
    );

    await run(worker);

    expect(writtenRow(createMany).status).toBe('skipped');
  });

  it('the SKIP is written even on a window shorter than the opt-out floor', async () => {
    // 09:50–10:00 = 10 minutes, under the 30-minute default floor.
    const { worker, createMany } = makeWorker(
      { billSkippedMeals: false },
      { windowOpen: '09:50' },
    );

    await run(worker);

    expect(writtenRow(createMany).status).toBe('skipped');
  });

  it('BILL-SKIP group: the System SKIP carries its price snapshot', async () => {
    const { worker, createMany } = makeWorker({ billSkippedMeals: true });

    await run(worker);

    const row = writtenRow(createMany);
    expect(row.status).toBe('skipped');
    // Skip Billed ON ⇒ billed by the existing rules, at the scheduled price.
    expect(row.price).toBe(60);
  });

  it('ATTENDANCE-ONLY group never bills, even with Bill-Skip ON', async () => {
    const { worker, createMany } = makeWorker({
      mealsEnabled: false,
      billSkippedMeals: true,
    });

    await run(worker);

    const row = writtenRow(createMany);
    expect(row.status).toBe('skipped');
    expect(row.price).toBeNull();
  });
});

describe('ISSUE-004 — the opt-out auto-Present model is unchanged', () => {
  it('OPT-OUT group writes PRESENT when a reminder went out', async () => {
    const { worker, createMany } = makeWorker(
      { attendanceDefault: 'present' },
      { reminderDispatched: true },
    );

    await run(worker);

    const row = writtenRow(createMany);
    expect(row.status).toBe('present');
    expect(row.price).toBe(60);
  });

  it('auto-PRESENT is still withheld when no reminder was dispatched', async () => {
    // FR-TRUST-003: a member promised a reminder that never arrived is
    // neutralized, not recorded as having eaten. This gate is NOT relaxed.
    const { worker, createMany } = makeWorker(
      { attendanceDefault: 'present' },
      { reminderDispatched: false },
    );

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('auto-PRESENT is still withheld on a window under the opt-out floor', async () => {
    const { worker, createMany } = makeWorker(
      { attendanceDefault: 'present' },
      { reminderDispatched: true, windowOpen: '09:50' },
    );

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('ISSUE-004 — corner cases: nothing is written when it must not be', () => {
  it('window still OPEN → no record (the member can still respond)', async () => {
    // Frozen clock is 18:00, so 17:00–19:00 is open, not closed.
    const { worker, createMany } = makeWorker(
      {},
      { windowOpen: '17:00', windowClose: '19:00' },
    );

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('meal with NO bounded window → no record (no fair close point)', async () => {
    const { worker, createMany } = makeWorker(
      {},
      { windowOpen: null as any, windowClose: null as any },
    );

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('ARCHIVED meal in master mode → no record', async () => {
    const { worker, createMany } = makeWorker({}, { mealActive: false });

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('PLANNER mode with no published entry (holiday) → no record', async () => {
    // FR-MODE-032: an unscheduled day is a no-meal day, never auto-materialized.
    const { worker, createMany } = makeWorker({ weeklyMenuEnabled: true });

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('member ALREADY responded → never re-defaulted (their mark wins)', async () => {
    const { worker, createMany } = makeWorker({}, { alreadyMarked: true });

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('member ON VACATION → excluded from the System SKIP', async () => {
    const { worker, createMany } = makeWorker({}, { onVacation: true });

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('no active groups → sweep is a no-op', async () => {
    const { worker, createMany, prisma } = makeWorker({}, { noGroups: true });

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
    // It must not go on to query meals for a group set it never got.
    expect(prisma.meal.findMany).not.toHaveBeenCalled();
  });

  it('group with no attendance-enabled meals → no record', async () => {
    const { worker, createMany } = makeWorker({}, { noMeals: true });

    await run(worker);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('a written SKIP is idempotent against a racing self-mark', async () => {
    // The unique(userId, mealId, attendanceDate) constraint is the real guard;
    // the sweep must always defer to it rather than upserting over a member.
    const { worker, createMany } = makeWorker();

    await run(worker);

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });
});
