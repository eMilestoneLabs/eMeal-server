import {
  getVacationCoveredUserIds,
  requestCoversMeal,
} from './vacation-coverage.util';

/**
 * Pass 11 (FR-VACX-003) — meal-granular vacation boundary math.
 * Scenario: vacation 10–12 Jun, leaving after lunch on the 10th
 * (startSlotKey='dinner') and returning before dinner on the 12th
 * (endSlotKey='lunch'). Slot opens: breakfast 07:00, lunch 12:00, dinner 19:00.
 */
describe('requestCoversMeal (FR-VACX-003)', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const slotOpens = (slotKey: string): number | null =>
    ({ breakfast: 7 * 60, lunch: 12 * 60, dinner: 19 * 60 })[slotKey] ?? null;

  const req = {
    groupId: null,
    startDate: d('2026-06-10'),
    endDate: d('2026-06-12'),
    startSlotKey: 'dinner',
    endSlotKey: 'lunch',
  };

  it('outside the range → not covered', () => {
    expect(requestCoversMeal(req, d('2026-06-09'), 12 * 60, slotOpens)).toBe(false);
    expect(requestCoversMeal(req, d('2026-06-13'), 12 * 60, slotOpens)).toBe(false);
  });

  it('start day: lunch is NORMAL, dinner onward is covered', () => {
    expect(requestCoversMeal(req, d('2026-06-10'), 12 * 60, slotOpens)).toBe(false);
    expect(requestCoversMeal(req, d('2026-06-10'), 19 * 60, slotOpens)).toBe(true);
  });

  it('interior day: fully covered', () => {
    expect(requestCoversMeal(req, d('2026-06-11'), 7 * 60, slotOpens)).toBe(true);
  });

  it('end day: lunch covered, dinner NORMAL (back before dinner)', () => {
    expect(requestCoversMeal(req, d('2026-06-12'), 12 * 60, slotOpens)).toBe(true);
    expect(requestCoversMeal(req, d('2026-06-12'), 19 * 60, slotOpens)).toBe(false);
  });

  it('no slot bounds → whole boundary days covered', () => {
    const whole = { ...req, startSlotKey: null, endSlotKey: null };
    expect(requestCoversMeal(whole, d('2026-06-10'), 7 * 60, slotOpens)).toBe(true);
    expect(requestCoversMeal(whole, d('2026-06-12'), 19 * 60, slotOpens)).toBe(true);
  });

  it('windowless meal / unknown slot → fail-safe covered on boundary day', () => {
    expect(requestCoversMeal(req, d('2026-06-10'), null, slotOpens)).toBe(true);
    expect(
      requestCoversMeal(
        { ...req, startSlotKey: 'unknown-slot' },
        d('2026-06-10'),
        7 * 60,
        slotOpens,
      ),
    ).toBe(true);
  });
});

// ── GROUP SCOPING of an approved request ───────────────────────────────────
//
// `if (r.groupId && r.groupId !== groupId) continue;` decides which requests
// govern the group being evaluated. Since the read-side spill compensation was
// removed (A-full fixed ownership at the WRITE), this line is the only thing
// keeping one group's approved leave out of another group's coverage — so it
// is pinned directly.
describe('getVacationCoveredUserIds — request group scoping', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const DATE = d('2026-08-12');

  const prismaWith = (requests: any[]) =>
    ({
      vacationRequest: { findMany: async () => requests },
      meal: { findMany: async () => [] },
    }) as any;

  const run = (requests: any[], groupId: string, flag = false) =>
    getVacationCoveredUserIds(prismaWith(requests), {
      organizationId: 'org1',
      groupId,
      dateUtc: DATE,
      mealOpenTime: null,
      candidates: [{ userId: 'u1', isVacationMode: flag }],
    });

  const req = (groupId: string | null) => ({
    userId: 'u1',
    groupId,
    startDate: d('2026-08-10'),
    endDate: d('2026-08-14'),
    startSlotKey: null,
    endSlotKey: null,
  });

  it('a GROUP-A request covers group A', async () => {
    expect([...(await run([req('grp_A')], 'grp_A'))]).toEqual(['u1']);
  });

  it('a GROUP-A request does NOT cover group B', async () => {
    // Foreign-group leave must never suppress attendance or billing here.
    expect([...(await run([req('grp_A')], 'grp_B'))]).toEqual([]);
  });

  it('an ORG-LEVEL request (groupId null) covers EVERY group', async () => {
    for (const g of ['grp_A', 'grp_B']) {
      expect([...(await run([req(null)], g))]).toEqual(['u1']);
    }
  });

  it('with no governing request the effective flag decides (instant toggle)', async () => {
    expect([...(await run([], 'grp_B', true))]).toEqual(['u1']);
    expect([...(await run([], 'grp_B', false))]).toEqual([]);
  });

  it('a foreign-group request does not mask a genuine ORG-WIDE vacation', async () => {
    // Post A-full the flag means org-wide, so it must still cover group B even
    // while a group-A request exists. The removed compensation used to
    // suppress exactly this case.
    expect([...(await run([req('grp_A')], 'grp_B', true))]).toEqual(['u1']);
  });
});
