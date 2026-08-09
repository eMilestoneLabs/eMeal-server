import { PlannerModeConversionService } from '../services/planner-mode-conversion.service';

/**
 * Live-Test-15 ISSUE-1 (user-locked) — WEEKLY ⇆ DAY-WISE mode conversion.
 *
 * The invariant under test, in one line:
 *   Switching planner mode builds a DRAFT in the target mode and NEVER
 *   replaces the group's currently effective published schedule.
 *
 * Seeding rules asserted here:
 *   WEEKLY → DAY_WISE : Today + Tomorrow ← currently published configuration.
 *   DAY_WISE → WEEKLY : Today + Tomorrow ← currently published configuration,
 *                       remaining five weekdays ← Master Meal Template
 *                       (written as PURE INHERITANCE — no frozen overrides).
 */
describe('PlannerModeConversionService', () => {
  const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

  /** A published snapshot entry carrying real per-day overrides. */
  const published = (mealId: string, date: string, dayOfWeek: number) => ({
    mealId,
    dayOfWeek,
    date: utc(date).toISOString(),
    openTime: '18:00',
    closeTime: '21:00',
    mealName: null,
    description: 'published desc',
    imageUrl: null,
    preferencesEnabled: true,
    enabledPreferences: ['veg'],
    enabledPreferenceGroupIds: ['pg1'],
    menuItems: ['Dal', 'Rice'],
    price: 175,
    meal: null,
  });

  /** Captured writes, so we can assert exactly what the conversion persisted. */
  interface Captured {
    createdEntries: any[];
    scheduleUpdates: any[];
    createdSchedules: any[];
    deletedForSchedules: string[];
  }

  const makePrisma = (opts: {
    snapshot: unknown[];
    weekStarts: string[]; // existing published rows
    mealIds: string[];
    dayWiseMealsEnabled: boolean;
    /** Live rows of a LEGACY published week (null snapshot). */
    liveEntries?: any[];
    publishedAt?: Date | null;
  }) => {
    const captured: Captured = {
      createdEntries: [],
      scheduleUpdates: [],
      createdSchedules: [],
      deletedForSchedules: [],
    };

    const rows = opts.weekStarts.map((w, i) => ({
      id: `sched${i}`,
      weekStart: utc(w),
      publishedSnapshot: opts.snapshot,
      publishedAt: opts.publishedAt ?? null,
      entries: [],
      group: { dayWiseMealsEnabled: opts.dayWiseMealsEnabled },
    }));

    const findSchedule = (args: any) => {
      const wanted: Date | undefined = args?.where?.weekStart;
      if (wanted) {
        return (
          rows.find((r) => r.weekStart.getTime() === wanted.getTime()) ?? null
        );
      }
      return (
        [...rows].sort(
          (a, b) => b.weekStart.getTime() - a.weekStart.getTime(),
        )[0] ?? null
      );
    };

    const tx = {
      mealSchedule: {
        findFirst: async (args: any) => findSchedule(args),
        update: async (args: any) => {
          captured.scheduleUpdates.push(args);
          return { id: args.where.id };
        },
        create: async (args: any) => {
          captured.createdSchedules.push(args);
          const id = `new-${captured.createdSchedules.length}`;
          return { id };
        },
      },
      scheduleEntry: {
        findMany: async () => opts.liveEntries ?? [],
        deleteMany: async (args: any) => {
          captured.deletedForSchedules.push(args.where.scheduleId);
          return { count: 0 };
        },
        createMany: async (args: any) => {
          captured.createdEntries.push(...args.data);
          return { count: args.data.length };
        },
      },
    };

    const prisma = {
      organization: {
        findUnique: async () => ({ timezone: 'Asia/Kolkata' }),
      },
      meal: {
        findMany: async () => opts.mealIds.map((id) => ({ id })),
      },
      mealSchedule: { findFirst: async (args: any) => findSchedule(args) },
      group: { findFirst: async () => ({ dayWiseMealsEnabled: opts.dayWiseMealsEnabled }) },
      $transaction: async (fn: any) => fn(tx),
    };

    return { prisma, captured };
  };

  const run = async (
    prisma: any,
    targetMode: 'WEEKLY' | 'DAY_WISE',
  ): Promise<void> => {
    const audit = { log: jest.fn() } as any;
    const svc = new PlannerModeConversionService(prisma, audit, null);
    await svc.convertOnModeChange({
      groupId: 'g1',
      organizationId: 'o1',
      actorId: 'admin1',
      targetMode,
    });
  };

  const dateOf = (e: any) => new Date(e.date).toISOString().slice(0, 10);

  afterEach(() => jest.useRealTimers());

  /** Thursday 2026-08-06 (week starts Monday 2026-08-03). */
  const pinThursday = () =>
    jest.useFakeTimers().setSystemTime(new Date('2026-08-06T10:00:00.000Z'));

  /** Sunday 2026-08-09 — "tomorrow" is Monday 2026-08-10, the NEXT ISO week. */
  const pinSunday = () =>
    jest.useFakeTimers().setSystemTime(new Date('2026-08-09T10:00:00.000Z'));

  it('WEEKLY → DAY_WISE: writes exactly Today + Tomorrow, seeded from the published schedule', async () => {
    pinThursday();
    const { prisma, captured } = makePrisma({
      snapshot: [published('m1', '2026-08-06', 3), published('m1', '2026-08-07', 4)],
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true,
    });

    await run(prisma, 'DAY_WISE');

    const dates = captured.createdEntries.map(dateOf).sort();
    expect(dates).toEqual(['2026-08-06', '2026-08-07']);
    // Published overrides copied verbatim.
    expect(captured.createdEntries[0]).toMatchObject({
      openTime: '18:00',
      closeTime: '21:00',
      price: 175,
      preferencesEnabled: true,
      enabledPreferences: ['veg'],
      enabledPreferenceGroupIds: ['pg1'],
      menuItems: ['Dal', 'Rice'],
    });
  });

  it('DAY_WISE → WEEKLY: 7 weekday cells — Today/Tomorrow published, the other 5 inherit Master', async () => {
    pinThursday();
    const { prisma, captured } = makePrisma({
      snapshot: [published('m1', '2026-08-06', 3), published('m1', '2026-08-07', 4)],
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true, // still Day-Wise at read time; target is WEEKLY
    });

    await run(prisma, 'WEEKLY');

    expect(captured.createdEntries).toHaveLength(7);
    const byDate = new Map(captured.createdEntries.map((e) => [dateOf(e), e]));

    // Seeded from the published Day-Wise days.
    expect(byDate.get('2026-08-06')).toMatchObject({ price: 175, openTime: '18:00' });
    expect(byDate.get('2026-08-07')).toMatchObject({ price: 175, openTime: '18:00' });

    // The other five are PURE INHERITANCE — never frozen master values.
    for (const d of ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-08', '2026-08-09']) {
      expect(byDate.get(d)).toMatchObject({
        openTime: null,
        closeTime: null,
        description: null,
        preferencesEnabled: null,
        price: null,
        enabledPreferences: [],
        menuItems: [],
      });
    }
  });

  it('DAY_WISE on a SUNDAY spans two week rows — Tomorrow is the real next calendar date', async () => {
    pinSunday();
    const { prisma, captured } = makePrisma({
      snapshot: [published('m1', '2026-08-09', 6)],
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true,
    });

    await run(prisma, 'DAY_WISE');

    const dates = captured.createdEntries.map(dateOf).sort();
    expect(dates).toEqual(['2026-08-09', '2026-08-10']);
    // Sunday's row already existed; Monday's belongs to the NEXT week and is created.
    expect(captured.createdSchedules).toHaveLength(1);
    expect(captured.createdSchedules[0].data.weekStart).toEqual(utc('2026-08-10'));
    expect(captured.createdSchedules[0].data.isPublished).toBe(false);
  });

  it('NEVER touches publishedSnapshot or publishedAt — the published schedule stays operational', async () => {
    pinThursday();
    const { prisma, captured } = makePrisma({
      snapshot: [published('m1', '2026-08-06', 3)],
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true,
    });

    await run(prisma, 'DAY_WISE');

    for (const upd of captured.scheduleUpdates) {
      expect(upd.data).toEqual({ isPublished: false }); // Auto-Draft, nothing else
    }
    for (const created of captured.createdSchedules) {
      expect(created.data.publishedSnapshot).toBeUndefined();
      expect(created.data.publishedAt).toBeUndefined();
    }
  });

  it('meal identity is never overridden — mealName and imageUrl always inherit the master', async () => {
    pinThursday();
    const { prisma, captured } = makePrisma({
      snapshot: [published('m1', '2026-08-06', 3)],
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true,
    });

    await run(prisma, 'DAY_WISE');

    for (const e of captured.createdEntries) {
      expect(e.mealName).toBeNull();
      expect(e.imageUrl).toBeNull();
    }
  });

  it('a group with no active master meals is left completely untouched', async () => {
    pinThursday();
    const { prisma, captured } = makePrisma({
      snapshot: [],
      weekStarts: ['2026-08-03'],
      mealIds: [],
      dayWiseMealsEnabled: false,
    });

    await run(prisma, 'DAY_WISE');

    expect(captured.createdEntries).toHaveLength(0);
    expect(captured.scheduleUpdates).toHaveLength(0);
    expect(captured.createdSchedules).toHaveLength(0);
  });

  it('LEGACY published row (null snapshot) is FROZEN before its draft is cleared', async () => {
    // `scheduleFromSnapshot` documents that a published row with a null
    // snapshot serves its LIVE entries as the published schedule, and that
    // "every week published by an older build has a null snapshot". Clearing
    // the draft on such a row would DELETE the published schedule, so it must
    // be materialised into publishedSnapshot first.
    pinThursday();
    const liveRow = {
      id: 'e1',
      scheduleId: 'sched0',
      mealId: 'm1',
      dayOfWeek: 3,
      date: utc('2026-08-06'),
      openTime: '18:00',
      closeTime: '21:00',
      price: 175,
      enabledPreferences: [],
      enabledPreferenceGroupIds: [],
      menuItems: [],
      meal: { slotKey: 'dinner', name: 'Dinner', order: 1 },
    };
    const { prisma, captured } = makePrisma({
      snapshot: [], // LEGACY: published, but no snapshot
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true,
      liveEntries: [liveRow],
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await run(prisma, 'DAY_WISE');

    const freeze = captured.scheduleUpdates.find(
      (u) => u.data?.publishedSnapshot !== undefined,
    );
    expect(freeze).toBeDefined();
    expect(freeze.data.publishedSnapshot).toHaveLength(1);
    expect(freeze.data.publishedSnapshot[0]).toMatchObject({
      mealId: 'm1',
      price: 175,
      openTime: '18:00',
    });
    // publishedAt itself is never rewritten — only the snapshot is filled in.
    expect(freeze.data.publishedAt).toBeUndefined();
  });

  it('a row that ALREADY has a snapshot is never re-frozen', async () => {
    pinThursday();
    const { prisma, captured } = makePrisma({
      snapshot: [published('m1', '2026-08-06', 3)],
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true,
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await run(prisma, 'DAY_WISE');

    expect(
      captured.scheduleUpdates.some(
        (u) => u.data?.publishedSnapshot !== undefined,
      ),
    ).toBe(false);
  });

  it('is fail-soft — a persistence failure never propagates to the group save', async () => {
    pinThursday();
    const { prisma } = makePrisma({
      snapshot: [published('m1', '2026-08-06', 3)],
      weekStarts: ['2026-08-03'],
      mealIds: ['m1'],
      dayWiseMealsEnabled: true,
    });
    (prisma as any).$transaction = async () => {
      throw new Error('db down');
    };

    await expect(run(prisma, 'DAY_WISE')).resolves.toBeUndefined();
  });
});
