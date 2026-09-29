import { retainedDataFrom } from '../utils/retention-floor.util';
import { BillingService } from '../../features/billing/billing.service';

/** Live-Test-16 ISSUE-14: pickers must not offer already-purged dates. */
describe('retainedDataFrom', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  it('null when retention has not initialized (caller keeps its default)', () => {
    expect(retainedDataFrom({ retentionPurgeThrough: null }, 3)).toBeNull();
  });

  it('calendar cycles: boundary 31 Mar, 3 cycles → window starts 1 Jan', () => {
    expect(
      retainedDataFrom({ retentionPurgeThrough: d('2026-03-31'), createdAt: d('2025-06-01') }, 3),
    ).toBe('2026-01-01');
  });

  it('after a purge the floor is the day after the previous boundary', () => {
    // previous boundary 31 Mar → purged → next boundary 30 Jun.
    expect(
      retainedDataFrom({ retentionPurgeThrough: d('2026-06-30'), createdAt: d('2025-06-01') }, 3),
    ).toBe('2026-04-01');
  });

  it('cycle day 15: boundary 14 Apr, 3 cycles → window starts 15 Jan', () => {
    expect(
      retainedDataFrom(
        { retentionPurgeThrough: d('2026-04-14'), billingCycleStartDay: 15, createdAt: d('2025-01-01') },
        3,
      ),
    ).toBe('2026-01-15');
  });

  it('never earlier than the group itself', () => {
    expect(
      retainedDataFrom({ retentionPurgeThrough: d('2026-03-31'), createdAt: d('2026-02-10') }, 3),
    ).toBe('2026-02-10');
  });

  it('AO → first-publish transition window keeps pre-publication history pickable', () => {
    expect(
      retainedDataFrom(
        {
          retentionPurgeThrough: d('2026-06-14'),
          billingCycleStartDay: 15,
          firstSchedulePublishedAt: d('2026-03-20'),
          createdAt: d('2026-01-05'),
        },
        3,
      ),
    ).toBe('2026-01-05');
  });

  it('uses the SAME calendar engine as billing (no second implementation)', () => {
    const spy = jest.spyOn(BillingService.prototype, 'resolveCurrentPeriod');
    // Unique inputs so the memo cannot answer this call.
    retainedDataFrom({ retentionPurgeThrough: d('2031-03-31') }, 3);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('memoizes: identical inputs never re-run the calendar walk', () => {
    const g = { retentionPurgeThrough: d('2032-06-30'), billingCycleStartDay: 10, createdAt: d('2031-01-01') };
    const first = retainedDataFrom(g, 3);
    const spy = jest.spyOn(BillingService.prototype, 'resolveCurrentPeriod');
    expect(retainedDataFrom({ ...g }, 3)).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    // A changed input (e.g. the boundary advanced after a purge) recomputes.
    expect(retainedDataFrom({ ...g, retentionPurgeThrough: d('2032-09-30') }, 3)).not.toBe(first);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
