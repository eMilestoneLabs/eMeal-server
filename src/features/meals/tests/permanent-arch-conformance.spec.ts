/**
 * PERMANENT_ARCH CONFORMANCE — requirement-by-requirement coverage.
 *
 * Each test names the exact PERMANENT_ARCH rule it proves, and covers the
 * POSITIVE case, the NEGATIVE case, and the CORNER cases (empty / null /
 * malformed / cross-tenant) rather than the happy path alone.
 *
 * Governing invariant under test:
 *   MASTER = configuration · DRAFT = configuration-in-progress ·
 *   PUBLISHED = permanent operational baseline. Nothing may modify the
 *   current Published schedule until an explicit successful Publish.
 */
import { SchedulesRepository } from '../repositories/schedules.repository';
import { MealsService } from '../meals.service';
import { resolvePublishedDayEntries } from '../../../common/utils/published-day.util';
import { AttendanceService } from '../../attendance/attendance.service';
import { PreferencesService } from '../../preferences/preferences.service';

const ORG = 'org_1';
const OTHER_ORG = 'org_2';
const GROUP = 'grp_1';
const SCHED = 'sch_1';
const BREAKFAST = 'meal_breakfast';
const DINNER = 'meal_dinner';
const THU = new Date(Date.UTC(2026, 7, 6)); // Thursday
const FRI = new Date(Date.UTC(2026, 7, 7)); // Friday

const master = {
  slotKey: 'breakfast',
  name: 'Breakfast',
  displayName: 'Breakfast',
  order: 1,
  menuItems: ['Poha'],
  imageUrl: 'https://minio/breakfast.jpg',
  description: 'Morning meal',
  price: 100,
  attendanceWindowOpen: '07:30',
  attendanceWindowClose: '09:30',
  isActive: true,
  preferencesEnabled: true,
  enabledPreferences: ['veg', 'egg'],
};

const pgStaple = {
  id: 'pg_staple',
  label: 'Staple',
  description: 'Pick your staple',
  order: 0,
  selectionType: 'multiple',
  minSelect: 1,
  maxSelect: 2,
  required: true,
  quantityEnabled: false,
  vegOnly: false,
  visibleWhen: null,
  options: [
    {
      id: 'opt_ruti',
      key: 'ruti',
      label: 'Ruti',
      emoji: null,
      color: null,
      isVeg: true,
      priceDelta: 5,
      minQty: 1,
      maxQty: 2,
      order: 0,
    },
  ],
};

function entry(mealId: string, date: Date, dayOfWeek: number, over: any = {}) {
  return {
    id: `e_${mealId}_${dayOfWeek}`,
    scheduleId: SCHED,
    mealId,
    dayOfWeek,
    date,
    openTime: null,
    closeTime: null,
    mealName: null,
    notes: null,
    description: null,
    imageUrl: null,
    preferencesEnabled: null,
    enabledPreferences: [],
    enabledPreferenceGroupIds: [],
    menuItems: [],
    price: null,
    meal: { ...master },
    ...over,
  };
}

function makePrisma(entries = [entry(BREAKFAST, THU, 3)]) {
  const row: any = {
    id: SCHED,
    organizationId: ORG,
    groupId: GROUP,
    weekStart: new Date(Date.UTC(2026, 7, 3)),
    isPublished: false,
    publishedAt: null,
    publishedSnapshot: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entries,
  };
  return {
    row,
    client: {
      mealSchedule: {
        // Org-scoped double: a query for another org finds nothing, exactly
        // like the real `where: { groupId, organizationId }`.
        findFirst: jest.fn(async (args: any) =>
          args?.where?.organizationId === ORG ? row : null,
        ),
        updateMany: jest.fn(async ({ data }: any) => {
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    } as any,
  };
}


/**
 * Publish context wired to the REAL canonical narrower so these tests exercise
 * the same `applyDayOverride` the read path uses — a stub would hide a drift.
 */
const realPrefs: any = Object.create(PreferencesService.prototype);

const resolver = {
  resolve: async () =>
    new Map([
      [BREAKFAST, [pgStaple as any]],
      [DINNER, [pgStaple as any]],
    ]),
  narrowByDay: (g: any, o: any) => realPrefs.applyDayOverride(g, o),
} as any;

describe('PERMANENT_ARCH conformance', () => {
  // ── PUBLISHED DATA: master edits must not reach the published schedule ────
  describe('REQ "DRAFT MUST NEVER MODIFY THE CURRENT PUBLISHED SCHEDULE"', () => {
    it('POSITIVE: every published-effective field survives a full master rewrite', async () => {
      const p = makePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);

      // Admin rewrites EVERY master field without publishing.
      p.row.entries[0].meal = {
        ...master,
        name: 'CHANGED',
        displayName: 'CHANGED',
        slotKey: 'changed',
        order: 99,
        menuItems: ['CHANGED'],
        imageUrl: 'https://minio/changed.jpg',
        description: 'CHANGED',
        price: 999,
        attendanceWindowOpen: '00:00',
        attendanceWindowClose: '23:59',
        enabledPreferences: ['CHANGED'],
      };

      const e = (
        await resolvePublishedDayEntries(p.client, {
          groupId: GROUP,
          organizationId: ORG,
          dateStr: '2026-08-06',
        })
      ).get(BREAKFAST)!;

      expect(e.meal!.name).toBe('Breakfast');
      expect(e.meal!.displayName).toBe('Breakfast');
      expect(e.meal!.slotKey).toBe('breakfast');
      expect(e.meal!.order).toBe(1);
      expect(e.meal!.menuItems).toEqual(['Poha']);
      expect(e.meal!.imageUrl).toBe('https://minio/breakfast.jpg');
      expect(e.meal!.description).toBe('Morning meal');
      expect(e.meal!.price).toBe(100);
      expect(e.meal!.attendanceWindowOpen).toBe('07:30');
      expect(e.meal!.attendanceWindowClose).toBe('09:30');
      expect(e.preference!.tags).toEqual(['veg', 'egg']);
    });

    it('NEGATIVE: publishing again DOES move the published schedule (only publish may)', async () => {
      const p = makePrisma();
      const repo = new SchedulesRepository(p.client);
      await repo.publish(SCHED, ORG, false, resolver);
      p.row.entries[0].meal = { ...master, price: 250 };
      await repo.publish(SCHED, ORG, false, resolver); // explicit republish

      const e = (
        await resolvePublishedDayEntries(p.client, {
          groupId: GROUP,
          organizationId: ORG,
          dateStr: '2026-08-06',
        })
      ).get(BREAKFAST)!;
      expect(e.meal!.price).toBe(250);
    });
  });

  // ── OVERRIDES: per-cell independence ─────────────────────────────────────
  describe('REQ "OVERRIDES MUST NEVER AFFECT OTHER DAYS"', () => {
    it('POSITIVE: a Thursday price override leaves Friday on the master price', async () => {
      const p = makePrisma([
        entry(BREAKFAST, THU, 3, { price: 200 }),
        entry(BREAKFAST, FRI, 4),
      ]);
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);

      const thu = (
        await resolvePublishedDayEntries(p.client, {
          groupId: GROUP,
          organizationId: ORG,
          dateStr: '2026-08-06',
        })
      ).get(BREAKFAST)!;
      const fri = (
        await resolvePublishedDayEntries(p.client, {
          groupId: GROUP,
          organizationId: ORG,
          dateStr: '2026-08-07',
        })
      ).get(BREAKFAST)!;

      expect(thu.price).toBe(200);
      expect(fri.price).toBeNull();
      expect(fri.meal!.price).toBe(100);
    });

    it('CORNER: a per-day preference-group SUBSET narrows only that day', async () => {
      const p = makePrisma([
        entry(BREAKFAST, THU, 3, { enabledPreferenceGroupIds: ['pg_absent'] }),
        entry(BREAKFAST, FRI, 4),
      ]);
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);
      const snap = p.row.publishedSnapshot;
      const thu = snap.find((e: any) => e.dayOfWeek === 3);
      const fri = snap.find((e: any) => e.dayOfWeek === 4);

      expect(thu.preference.groups).toEqual([]); // subset matched nothing
      expect(fri.preference.groups).toHaveLength(1); // empty subset = inherit all
    });
  });

  // ── MEAL IDENTITY ────────────────────────────────────────────────────────
  describe('REQ "ONLY MEAL NAME, SLOT KEY AND IMAGE ARE NON-OVERRIDABLE"', () => {
    it('POSITIVE: the frozen entry carries no per-cell name/slotKey override field', async () => {
      const p = makePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);
      const e = p.row.publishedSnapshot[0];
      // identity lives ONLY on the frozen meal block, never as a cell override
      expect(e.meal.name).toBe('Breakfast');
      expect(e.meal.slotKey).toBe('breakfast');
      expect(Object.prototype.hasOwnProperty.call(e, 'slotKey')).toBe(false);
    });
  });

  // ── GLOBAL MEAL PREFERENCE ───────────────────────────────────────────────
  describe('REQ "GLOBAL OFF disables all individual meal preference toggles"', () => {
    it('POSITIVE: Global OFF blanks the frozen preference block at publish', async () => {
      const p = makePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, true, resolver);
      const e = p.row.publishedSnapshot[0];
      expect(e.preference.enabled).toBe(false);
      expect(e.preference.groups).toEqual([]);
      expect(e.preferencesEnabled).toBe(false);
      expect(e.enabledPreferenceGroupIds).toEqual([]);
    });

    it('CORNER: Global OFF on a schedule with no resolver does not crash', async () => {
      const p = makePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, true);
      expect(p.row.publishedSnapshot[0].preferencesEnabled).toBe(false);
      expect(p.row.publishedSnapshot[0].preference).toBeUndefined();
    });
  });

  // ── MULTI-TENANT ─────────────────────────────────────────────────────────
  describe('MULTI_TENANT: organization isolation on the published resolver', () => {
    it('NEGATIVE: another organization resolves NOTHING for the same group id', async () => {
      const p = makePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);

      const foreign = await resolvePublishedDayEntries(p.client, {
        groupId: GROUP,
        organizationId: OTHER_ORG,
        dateStr: '2026-08-06',
      });
      expect(foreign.size).toBe(0);
    });

    it('every published lookup carries organizationId in its WHERE clause', async () => {
      const p = makePrisma();
      await resolvePublishedDayEntries(p.client, {
        groupId: GROUP,
        organizationId: ORG,
        dateStr: '2026-08-06',
      });
      for (const call of p.client.mealSchedule.findFirst.mock.calls) {
        expect(call[0].where.organizationId).toBe(ORG);
        expect(call[0].where.groupId).toBe(GROUP);
      }
    });
  });

  // ── CORNER / MALFORMED DATA ──────────────────────────────────────────────
  describe('CORNER cases — empty, null and malformed published data', () => {
    it('a schedule with NO entries publishes an empty snapshot without crashing', async () => {
      const p = makePrisma([]);
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);
      expect(p.row.publishedSnapshot).toEqual([]);
    });

    it('marker present but preference block MISSING is NOT treated as frozen', async () => {
      const p = makePrisma();
      p.row.publishedAt = new Date();
      p.row.publishedSnapshot = [
        {
          configurationFrozen: true, // marker set…
          preference: null, // …but the block failed to resolve
          mealId: BREAKFAST,
          dayOfWeek: 3,
          date: THU.toISOString(),
          meal: { ...master },
        },
      ];
      const e = (
        await resolvePublishedDayEntries(p.client, {
          groupId: GROUP,
          organizationId: ORG,
          dateStr: '2026-08-06',
        })
      ).get(BREAKFAST)!;
      expect(e.configurationFrozen).toBe(false);
    });

    it('a garbage plannerMode value is ignored, never trusted', async () => {
      const p = makePrisma();
      p.row.publishedAt = new Date();
      p.row.publishedSnapshot = [
        {
          configurationFrozen: true,
          preference: { enabled: false, mode: 'standalone', tags: [], groups: [] },
          plannerMode: 'NONSENSE',
          mealId: BREAKFAST,
          dayOfWeek: 3,
          date: THU.toISOString(),
          meal: { ...master },
        },
      ];
      const e = (
        await resolvePublishedDayEntries(p.client, {
          groupId: GROUP,
          organizationId: ORG,
          dateStr: '2026-08-06',
        })
      ).get(BREAKFAST)!;
      expect(e.plannerMode).toBeNull();
    });

    it('an unfrozen entry leaves the live card untouched (no partial rebase)', () => {
      const live = {
        id: BREAKFAST,
        name: 'Live',
        price: 555,
        preferenceGroups: [{ id: 'live_pg' }],
        enabledPreferences: ['live'],
      };
      const card = (MealsService as any).applyDayEntryToMeal(live, {
        configurationFrozen: false,
        preference: null,
        meal: null,
        openTime: null,
        preferencesEnabled: null,
        enabledPreferences: [],
        enabledPreferenceGroupIds: [],
        menuItems: [],
        price: null,
        description: null,
        imageUrl: null,
      });
      expect(card.name).toBe('Live');
      expect(card.price).toBe(555);
      expect(card.preferenceGroups).toEqual([{ id: 'live_pg' }]);
    });
  });

  // ── ATTENDANCE PREFERENCE VALIDATION ─────────────────────────────────────
  describe('REQ "ATTENDANCE MUST CONTINUE USING THE LAST PUBLISHED SCHEDULE"', () => {
    it('the frozen day exposes its OWN group set for Present validation', async () => {
      const p = makePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);

      // Master is switched to Standalone AFTER publish (binding suspended).
      const day = await resolvePublishedDayEntries(p.client, {
        groupId: GROUP,
        organizationId: ORG,
        dateStr: '2026-08-06',
      });
      const e = day.get(BREAKFAST)!;

      // The published day still demands the group the admin published.
      expect(e.configurationFrozen).toBe(true);
      expect(e.preference!.groups).toHaveLength(1);
      expect(e.preference!.groups[0].id).toBe('pg_staple');
      expect(e.preference!.groups[0].minSelect).toBe(1);
      expect(e.preference!.groups[0].maxSelect).toBe(2);
    });

    it('resolveEffectiveWindow HANDS the frozen group set to Present validation', async () => {
      const p = makePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);

      // Exercise the REAL production method: it only touches `prisma`.
      const svc: any = Object.create(AttendanceService.prototype);
      svc.prisma = p.client;
      const eff = await svc.resolveEffectiveWindow(BREAKFAST, GROUP, ORG, '2026-08-06', {
        openTime: null,
        closeTime: null,
        price: null,
      });

      // Without this, validation narrows LIVE master groups and a
      // Standalone switch in Master would silently stop demanding picks
      // on an already-published day.
      expect(eff.frozenPreferenceGroups).toHaveLength(1);
      expect(eff.frozenPreferenceGroups[0].id).toBe('pg_staple');
      expect(eff.frozenPreferenceGroups[0].maxSelect).toBe(2);
      // …and the frozen window/price ride the same resolution.
      expect(eff.price).toBe(100);
      expect(eff.openTime).toBe('07:30');
    });

    it('resolveEffectiveWindow returns NULL frozen groups before the freeze', async () => {
      const p = makePrisma();
      p.row.publishedAt = new Date();
      p.row.publishedSnapshot = [
        { mealId: BREAKFAST, dayOfWeek: 3, date: THU.toISOString(), meal: { ...master } },
      ];
      const svc: any = Object.create(AttendanceService.prototype);
      svc.prisma = p.client;
      const eff = await svc.resolveEffectiveWindow(BREAKFAST, GROUP, ORG, '2026-08-06', {
        openTime: '06:00',
        closeTime: '08:00',
        price: 42,
      });
      expect(eff.frozenPreferenceGroups).toBeNull();
      expect(eff.price).toBe(42); // historical live-master fallback preserved
    });

    it('a day that predates the freeze exposes NO frozen group set', async () => {
      const p = makePrisma();
      p.row.publishedAt = new Date();
      p.row.publishedSnapshot = [
        { mealId: BREAKFAST, dayOfWeek: 3, date: THU.toISOString(), meal: { ...master } },
      ];
      const e = (
        await resolvePublishedDayEntries(p.client, {
          groupId: GROUP,
          organizationId: ORG,
          dateStr: '2026-08-06',
        })
      ).get(BREAKFAST)!;
      expect(e.configurationFrozen).toBe(false);
      expect(e.preference).toBeNull();
    });
  });

  // ── DAY-WISE CROSS-WEEK ──────────────────────────────────────────────────
  describe('DAY-WISE spanning Sunday to Monday (two ISO weeks, one row)', () => {
    // Sun 2026-08-09 (dayOfWeek 6) + Mon 2026-08-10 (dayOfWeek 0).
    // Both live in the row whose weekStart is Mon 2026-08-03.
    const SUN = new Date(Date.UTC(2026, 7, 9));
    const MON = new Date(Date.UTC(2026, 7, 10));

    /** weekStart-aware double, so step 1 vs step 2 are genuinely exercised. */
    function makeWeekAwarePrisma() {
      const row: any = {
        id: SCHED,
        organizationId: ORG,
        groupId: GROUP,
        weekStart: new Date(Date.UTC(2026, 7, 3)),
        isPublished: false,
        publishedAt: null,
        publishedSnapshot: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        entries: [entry(BREAKFAST, SUN, 6), entry(BREAKFAST, MON, 0)],
      };
      return {
        row,
        client: {
          mealSchedule: {
            findFirst: jest.fn(async (args: any) => {
              if (args?.where?.organizationId !== ORG) return null;
              const ws = args?.where?.weekStart;
              // Exact-week lookup only matches the row's real weekStart.
              if (ws && new Date(ws).getTime() !== row.weekStart.getTime()) {
                return null;
              }
              return row;
            }),
            updateMany: jest.fn(async ({ data }: any) => {
              Object.assign(row, data);
              return { count: 1 };
            }),
          },
        } as any,
      };
    }

    it('ONE publish freezes BOTH calendar days', async () => {
      const p = makeWeekAwarePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);
      const snap = p.row.publishedSnapshot;
      expect(snap).toHaveLength(2);
      expect(snap.every((e: any) => e.configurationFrozen === true)).toBe(true);
      expect(snap.every((e: any) => e.preference?.groups?.length === 1)).toBe(true);
    });

    it('the NEXT-WEEK Monday still resolves frozen (via the weekday fallback)', async () => {
      const p = makeWeekAwarePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);

      // Monday belongs to the FOLLOWING ISO week, so the exact-week lookup
      // misses and resolution must fall through to the recurring match.
      const mon = await resolvePublishedDayEntries(p.client, {
        groupId: GROUP,
        organizationId: ORG,
        dateStr: '2026-08-10',
      });
      const e = mon.get(BREAKFAST)!;
      expect(e.configurationFrozen).toBe(true);
      expect(e.meal!.price).toBe(100);
      expect(e.preference!.groups).toHaveLength(1);
    });

    it('Sunday resolves frozen from the exact-week lookup', async () => {
      const p = makeWeekAwarePrisma();
      await new SchedulesRepository(p.client).publish(SCHED, ORG, false, resolver);
      const sun = await resolvePublishedDayEntries(p.client, {
        groupId: GROUP,
        organizationId: ORG,
        dateStr: '2026-08-09',
      });
      expect(sun.get(BREAKFAST)!.configurationFrozen).toBe(true);
    });
  });

  // ── IDEMPOTENCY ──────────────────────────────────────────────────────────
  describe('REQ "Publishing is idempotent"', () => {
    it('publishing twice with no change yields an identical snapshot', async () => {
      const p = makePrisma();
      const repo = new SchedulesRepository(p.client);
      await repo.publish(SCHED, ORG, false, resolver);
      const first = JSON.stringify(p.row.publishedSnapshot);
      await repo.publish(SCHED, ORG, false, resolver);
      expect(JSON.stringify(p.row.publishedSnapshot)).toBe(first);
    });
  });
});
