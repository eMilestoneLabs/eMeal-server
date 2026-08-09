import { freezeLegacyPublishedSnapshot } from './published-snapshot.util';

/**
 * Live-Test-15 ISSUE-1 §16 — "A DRAFT MUST NEVER MODIFY THE PUBLISHED SCHEDULE."
 *
 * This guard is the only thing standing between a `replaceEntries` write and
 * irreversible loss of a published week on LEGACY rows, where the published
 * view IS the live entries (null `publishedSnapshot`). It protects two call
 * sites — `SchedulesRepository.update` and `PlannerModeConversionService` — so
 * the rules are pinned here once.
 */
describe('freezeLegacyPublishedSnapshot', () => {
  const makeTx = (live: any[]) => {
    const updates: any[] = [];
    return {
      updates,
      tx: {
        scheduleEntry: { findMany: async () => live },
        mealSchedule: {
          update: async (args: any) => {
            updates.push(args);
            return { id: args.where.id };
          },
        },
      },
    };
  };

  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    scheduleId: 's1',
    mealId: 'm1',
    dayOfWeek: 3,
    date: new Date('2026-08-06T00:00:00.000Z'),
    openTime: '18:00',
    closeTime: '21:00',
    price: 175,
    enabledPreferences: ['veg'],
    enabledPreferenceGroupIds: ['pg1'],
    menuItems: ['Dal'],
    meal: { slotKey: 'dinner', name: 'Dinner', order: 2, price: 50 },
    ...over,
  });

  it('FREEZES a published row that has no snapshot (the data-loss case)', async () => {
    const { tx, updates } = makeTx([entry()]);
    await freezeLegacyPublishedSnapshot(tx, {
      id: 's1',
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      publishedSnapshot: null,
    });

    expect(updates).toHaveLength(1);
    const snap = updates[0].data.publishedSnapshot;
    expect(snap).toHaveLength(1);
    // Per-day overrides survive verbatim — this is what members were served.
    expect(snap[0]).toMatchObject({
      mealId: 'm1',
      openTime: '18:00',
      closeTime: '21:00',
      price: 175,
      enabledPreferences: ['veg'],
      enabledPreferenceGroupIds: ['pg1'],
      menuItems: ['Dal'],
    });
    // The frozen master metadata rides along so an archived meal still renders.
    expect(snap[0].meal).toMatchObject({ slotKey: 'dinner', name: 'Dinner' });
    // Dates are serialised — the shape published-day.util reads.
    expect(typeof snap[0].date).toBe('string');
    // publishedAt is NEVER rewritten: this freezes, it does not re-publish.
    expect(updates[0].data.publishedAt).toBeUndefined();
    expect(updates[0].data.isPublished).toBeUndefined();
  });

  it('is a NO-OP for an unpublished (pure draft) row', async () => {
    const { tx, updates } = makeTx([entry()]);
    await freezeLegacyPublishedSnapshot(tx, {
      id: 's1',
      publishedAt: null,
      publishedSnapshot: null,
    });
    expect(updates).toHaveLength(0);
  });

  it('is a NO-OP when a snapshot already exists (never overwrites it)', async () => {
    const { tx, updates } = makeTx([entry()]);
    await freezeLegacyPublishedSnapshot(tx, {
      id: 's1',
      publishedAt: new Date(),
      publishedSnapshot: [{ mealId: 'old' }],
    });
    expect(updates).toHaveLength(0);
  });

  it('is a NO-OP when the published row has no entries to freeze', async () => {
    const { tx, updates } = makeTx([]);
    await freezeLegacyPublishedSnapshot(tx, {
      id: 's1',
      publishedAt: new Date(),
      publishedSnapshot: null,
    });
    expect(updates).toHaveLength(0);
  });

  it('is idempotent — a second call after freezing does nothing', async () => {
    const { tx, updates } = makeTx([entry()]);
    const row = {
      id: 's1',
      publishedAt: new Date(),
      publishedSnapshot: null as unknown,
    };
    await freezeLegacyPublishedSnapshot(tx, row);
    row.publishedSnapshot = updates[0].data.publishedSnapshot;
    await freezeLegacyPublishedSnapshot(tx, row);
    expect(updates).toHaveLength(1);
  });

  it('tolerates a null row / missing entry relation without throwing', async () => {
    const { tx, updates } = makeTx([entry({ meal: null })]);
    await expect(
      freezeLegacyPublishedSnapshot(tx, null),
    ).resolves.toBeUndefined();
    await freezeLegacyPublishedSnapshot(tx, {
      id: 's1',
      publishedAt: new Date(),
      publishedSnapshot: null,
    });
    expect(updates[0].data.publishedSnapshot[0].meal).toBeUndefined();
  });
});
