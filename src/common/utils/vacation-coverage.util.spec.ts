import { requestCoversMeal } from './vacation-coverage.util';

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
