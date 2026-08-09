import { resolvePublishedDayEntries } from './published-day.util';

/**
 * Live-Test-15 ISSUE-1 (user-locked) — DAY-WISE ROLLING CARRY-FORWARD.
 *
 * This resolver is the SINGLE source of truth six enforcement paths share
 * (/meals/today, attendance marking, corrections, guest booking, vacation
 * coverage, the sweeps). These cases lock the two invariants that must never
 * regress:
 *
 *   1. WEEKLY behaviour is byte-identical to the pre-change resolver.
 *   2. DAY-WISE inherits the latest effective PUBLISHED day before the target
 *      — and NEVER an unpublished draft.
 *
 * Scenario mirrors the user's worked example:
 *   Published Thursday = A (₹100)   Published Friday = B (₹110)
 *   Saturday untouched → Saturday MUST resolve to B.
 */
describe('resolvePublishedDayEntries — Day-Wise carry-forward', () => {
  const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

  /** One published snapshot entry (the shape publishedSnapshot stores). */
  const entry = (mealId: string, date: string, dayOfWeek: number, price: number) => ({
    mealId,
    dayOfWeek,
    date: utc(date).toISOString(),
    openTime: '07:00',
    closeTime: '09:00',
    mealName: null,
    description: null,
    imageUrl: null,
    preferencesEnabled: null,
    enabledPreferences: [],
    enabledPreferenceGroupIds: [],
    menuItems: [],
    price,
    meal: null,
  });

  // 2026-08-06 = Thursday, 2026-08-07 = Friday, 2026-08-08 = Saturday.
  const THU = entry('breakfast', '2026-08-06', 3, 100);
  const FRI = entry('breakfast', '2026-08-07', 4, 110);

  /**
   * Minimal prisma double. `rows` are returned in weekStart-desc order for the
   * "latest published" lookup; the exact-week lookup matches on weekStart.
   */
  const fakePrisma = (
    rows: Array<{ weekStart: Date; publishedSnapshot: unknown }>,
    dayWiseMealsEnabled: boolean,
  ) => ({
    mealSchedule: {
      findFirst: async (args: any) => {
        const wanted: Date | undefined = args?.where?.weekStart;
        const match = wanted
          ? rows.find((r) => r.weekStart.getTime() === wanted.getTime())
          : [...rows].sort(
              (a, b) => b.weekStart.getTime() - a.weekStart.getTime(),
            )[0];
        if (!match) return null;
        return { ...match, entries: [] };
      },
    },
    // Perf: the planner mode is read through its OWN delegate, and only on the
    // miss path — never on the hot path where a published day already matched.
    group: { findFirst: async () => ({ dayWiseMealsEnabled }) },
  });

  const resolve = (
    prisma: ReturnType<typeof fakePrisma>,
    dateStr: string,
  ) =>
    resolvePublishedDayEntries(prisma as any, {
      groupId: 'g1',
      organizationId: 'o1',
      dateStr,
    });

  // Week of 2026-08-06 starts Monday 2026-08-03.
  const week = (snapshot: unknown[]) => [
    { weekStart: utc('2026-08-03'), publishedSnapshot: snapshot },
  ];

  it('exact published date still wins (step 1 unchanged)', async () => {
    const map = await resolve(fakePrisma(week([THU, FRI]), true), '2026-08-07');
    expect(map.get('breakfast')?.price).toBe(110);
  });

  it('DAY-WISE: an unplanned Saturday carries forward the published Friday', async () => {
    const map = await resolve(fakePrisma(week([THU, FRI]), true), '2026-08-08');
    expect(map.get('breakfast')?.price).toBe(110); // B, not the Thursday A
  });

  it('DAY-WISE: carry-forward keeps rolling forward indefinitely (no daily publish required)', async () => {
    const map = await resolve(fakePrisma(week([THU, FRI]), true), '2026-08-19');
    expect(map.get('breakfast')?.price).toBe(110);
  });

  it('DAY-WISE: a newly published day becomes the new baseline', async () => {
    const SAT = entry('breakfast', '2026-08-08', 5, 180);
    const map = await resolve(fakePrisma(week([THU, FRI, SAT]), true), '2026-08-09');
    expect(map.get('breakfast')?.price).toBe(180);
  });

  it('DAY-WISE: never carries BACKWARD from a later published day', async () => {
    // Wednesday precedes every published date → no baseline → master fallback.
    const map = await resolve(fakePrisma(week([THU, FRI]), true), '2026-08-05');
    expect(map.size).toBe(0);
  });

  it('WEEKLY: an unplanned day stays empty — carry-forward must NOT apply', async () => {
    const map = await resolve(fakePrisma(week([THU, FRI]), false), '2026-08-08');
    expect(map.size).toBe(0);
  });

  it('WEEKLY: weekday-recurring continuation still resolves (step 2 unchanged)', async () => {
    // Target 2026-08-13 (Thursday, next week) — no row for that week, so the
    // latest published row is matched by weekday.
    const map = await resolve(fakePrisma(week([THU, FRI]), false), '2026-08-13');
    expect(map.get('breakfast')?.price).toBe(100);
  });

  it('DRAFT WALL: an unpublished draft is never a carry-forward baseline', async () => {
    // publishedSnapshot holds only Thursday; the draft `entries` (Friday ₹999)
    // must be ignored because a non-empty snapshot always wins.
    const prisma = {
      mealSchedule: {
        findFirst: async () => ({
          weekStart: utc('2026-08-03'),
          publishedSnapshot: [THU],
          entries: [{ ...FRI, price: 999 }],
        }),
      },
      group: { findFirst: async () => ({ dayWiseMealsEnabled: true }) },
    };
    const map = await resolve(prisma as any, '2026-08-08');
    expect(map.get('breakfast')?.price).toBe(100); // Thursday A, never the ₹999 draft
  });

  it('HOT PATH COSTS NOTHING: a matched day never queries the group', async () => {
    // Prisma 5.10 runs WITHOUT the `relationJoins` preview feature, so a
    // relation `select` inside an `include` is a SEPARATE QUERY, not a JOIN.
    // Carrying the planner mode on the include would therefore have added a
    // round-trip to EVERY resolver call — /meals/today, attendance marking,
    // guest booking, vacation coverage and four worker sweeps.
    //
    // The mode is read only AFTER steps 1 and 2 both miss, i.e. on the path
    // that was already falling back to the Master template. This pins that.
    let groupQueries = 0;
    const prisma = {
      mealSchedule: {
        findFirst: async () => ({
          weekStart: utc('2026-08-03'),
          publishedSnapshot: [THU, FRI],
          entries: [],
        }),
      },
      group: {
        findFirst: async () => {
          groupQueries++;
          return { dayWiseMealsEnabled: true };
        },
      },
    };

    // Exact-date hit (step 1) — the hot case.
    await resolve(prisma as any, '2026-08-06');
    expect(groupQueries).toBe(0);

    // Weekday hit (step 2) — the recurring-continuation case.
    await resolve(prisma as any, '2026-08-13');
    expect(groupQueries).toBe(0);

    // Only a genuine miss pays for the mode lookup.
    await resolve(prisma as any, '2026-08-09');
    expect(groupQueries).toBe(1);
  });

  it('NOTHING TO CARRY: a group with no published schedule never queries the mode', async () => {
    // The mode lookup must not run on the most common miss of all — a group
    // that has never published anything. Carry-forward reads only rows already
    // in memory and can only return [] when no published day precedes the
    // date, so the mode cannot change the outcome and the query is pure waste
    // on a read path shared by /meals/today, attendance marking, guest
    // booking, vacation coverage and the worker sweeps.
    let groupQueries = 0;
    const prisma = {
      mealSchedule: { findFirst: async () => null }, // nothing ever published
      group: {
        findFirst: async () => {
          groupQueries++;
          return { dayWiseMealsEnabled: true };
        },
      },
    };

    const out = await resolve(prisma as any, '2026-08-09');
    expect(out.size).toBe(0); // falls back to Master, as before
    expect(groupQueries).toBe(0);
  });

  it('NOTHING TO CARRY: published days that are all AFTER the date cost no query', async () => {
    // Same rule, subtler shape: rows exist and are published, but every entry
    // post-dates the target, so carry-forward still cannot produce anything.
    let groupQueries = 0;
    const prisma = {
      mealSchedule: {
        findFirst: async () => ({
          weekStart: utc('2026-08-03'),
          publishedSnapshot: [THU, FRI], // 08-06, 08-07
          entries: [],
        }),
      },
      group: {
        findFirst: async () => {
          groupQueries++;
          return { dayWiseMealsEnabled: true };
        },
      },
    };

    // 2026-08-04 (Tue) — before every published day, and no weekday match.
    const out = await resolve(prisma as any, '2026-08-04');
    expect(out.size).toBe(0);
    expect(groupQueries).toBe(0);
  });

  it('CALLER-SUPPLIED mode: zero group queries even on the MISS path', async () => {
    // The sweeps call this once PER GROUP inside a loop and already select
    // `dayWiseMealsEnabled`, so a redundant per-group lookup multiplies by the
    // number of groups. Supplying it must remove the query entirely.
    let groupQueries = 0;
    const prisma = {
      mealSchedule: {
        findFirst: async () => ({
          weekStart: utc('2026-08-03'),
          publishedSnapshot: [THU, FRI],
          entries: [],
        }),
      },
      group: {
        findFirst: async () => {
          groupQueries++;
          return { dayWiseMealsEnabled: true };
        },
      },
    };

    const map = await resolvePublishedDayEntries(prisma as any, {
      groupId: 'g1',
      organizationId: 'o1',
      dateStr: '2026-08-09', // a MISS → step 2b
      dayWiseMealsEnabled: true, // caller already knows
    });
    expect(groupQueries).toBe(0);
    expect(map.get('breakfast')?.price).toBe(110); // carry-forward still applied

    // Explicit FALSE must also skip the query AND skip carry-forward.
    const weekly = await resolvePublishedDayEntries(prisma as any, {
      groupId: 'g1',
      organizationId: 'o1',
      dateStr: '2026-08-09',
      dayWiseMealsEnabled: false,
    });
    expect(groupQueries).toBe(0);
    expect(weekly.size).toBe(0);
  });

  it('a client whose group delegate lacks findFirst degrades safely (no throw)',
      async () => {
    // THE REAL SHAPE THAT BROKE: the sweep workers pass a prisma-like object
    // with `group.findMany` but NO `findFirst`. Guarding only the delegate
    // (`prisma.group?.findFirst()`) still threw "not a function" and took the
    // ENTIRE close sweep down — no System-SKIP rows were written at all.
    const prisma = {
      mealSchedule: {
        findFirst: async () => ({
          weekStart: utc('2026-08-03'),
          publishedSnapshot: [THU, FRI],
          entries: [],
        }),
      },
      group: { findMany: async () => [] }, // no findFirst — exactly the worker double
    };
    const map = await resolve(prisma as any, '2026-08-09');
    expect(map.size).toBe(0); // carry-forward skipped, master fallback, NO throw
  });

  it('a double WITHOUT a group delegate degrades safely (no throw)', async () => {
    const prisma = {
      mealSchedule: {
        findFirst: async () => ({
          weekStart: utc('2026-08-03'),
          publishedSnapshot: [THU, FRI],
          entries: [],
        }),
      },
    };
    const map = await resolve(prisma as any, '2026-08-09');
    expect(map.size).toBe(0); // carry-forward skipped, master fallback
  });

  it('SOURCE PRIORITY: an OBSOLETE Weekly matrix is never resurrected — fallback is MASTER', async () => {
    // User-locked rule: "take whatever comes from the DAY-WISE published
    // schedule, otherwise FULL FALLBACK TO MASTER" — never a previous Weekly
    // publish, because meals may have been deleted/disabled since.
    //
    // Week 2026-08-03 holds an OLD WEEKLY publish covering all 7 weekdays
    // (including a meal that no longer exists). Week 2026-08-10 holds the
    // CURRENT Day-Wise publish. Asking for a day the Day-Wise publish does not
    // cover must NOT fall back to the stale weekly row.
    const oldWeekly = [0, 1, 2, 3, 4, 5, 6].map((dow) =>
      entry('stale-meal', `2026-08-0${3 + dow}`, dow, 999),
    );
    const rows = [
      { weekStart: utc('2026-08-03'), publishedSnapshot: oldWeekly },
      // Day-Wise published Mon 10th only.
      {
        weekStart: utc('2026-08-10'),
        publishedSnapshot: [entry('breakfast', '2026-08-10', 0, 120)],
      },
    ];
    const prisma = fakePrisma(rows, true);

    // Tuesday 2026-08-11: not covered by the Day-Wise publish. Carry-forward
    // gives Monday's published config; the stale weekly meal must NOT appear.
    const map = await resolve(prisma, '2026-08-11');
    expect(map.get('stale-meal')).toBeUndefined();
    expect(map.get('breakfast')?.price).toBe(120);
  });

  it('WEEKLY group: an obsolete older week is never preferred over the latest publish', async () => {
    const oldWeekly = [entry('stale-meal', '2026-08-04', 1, 999)];
    const rows = [
      { weekStart: utc('2026-08-03'), publishedSnapshot: oldWeekly },
      {
        weekStart: utc('2026-08-10'),
        publishedSnapshot: [entry('breakfast', '2026-08-11', 1, 150)],
      },
    ];
    // Tuesday of a LATER week resolves through the newest row by weekday.
    const map = await resolve(fakePrisma(rows, false), '2026-08-18');
    expect(map.get('stale-meal')).toBeUndefined();
    expect(map.get('breakfast')?.price).toBe(150);
  });

  it('legacy double without the group relation → carry-forward skipped (fail-safe)', async () => {
    const prisma = {
      mealSchedule: {
        findFirst: async () => ({
          weekStart: utc('2026-08-03'),
          publishedSnapshot: [THU, FRI],
          entries: [],
        }),
      },
    };
    const map = await resolve(prisma as any, '2026-08-08');
    expect(map.size).toBe(0);
  });
});
