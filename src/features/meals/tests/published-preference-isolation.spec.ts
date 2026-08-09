/**
 * P-01 (Live-Test-15) — PUBLISHED SCHEDULE ISOLATION.
 *
 * The confirmed defect: switching a meal Standalone → Preference Group in the
 * MASTER template changed what students/attendance saw on the ALREADY
 * PUBLISHED schedule, before the admin pressed Publish.
 *
 * Root cause proven by the audit: operational reads rebuilt the published day
 * as `LIVE master ⊕ published per-day overrides`, and the frozen master block
 * the snapshot already carried was never read. Preference configuration was
 * not frozen at all.
 *
 * These cases pin the fix end-to-end:
 *   1. Publish freezes the COMPLETE effective preference configuration .
 *   2. A later MASTER mutation cannot move the published day.
 *   3. Legacy  snapshots keep their historical resolution — never
 *      reconstructed from today's Master (no fabricated history).
 *   4. Global Meal Preference OFF strips the frozen block at publish.
 */
import { SchedulesRepository } from '../repositories/schedules.repository';
import { MealsService } from '../meals.service';
import { PreferencesService } from '../../preferences/preferences.service';
import { resolvePublishedDayEntries } from '../../../common/utils/published-day.util';

const ORG = 'org_1';
const GROUP = 'grp_1';
const SCHED = 'sch_1';
const MEAL = 'meal_breakfast';
/** Thursday 2026-08-06 (dayOfWeek 3 = Thursday in the 0=Mon convention). */
const DATE = new Date(Date.UTC(2026, 7, 6));

/** The master meal as it stood AT PUBLISH TIME: ₹100, 07:30–09:30. */
const masterAtPublish = {
  slotKey: 'breakfast',
  name: 'Breakfast',
  displayName: 'Breakfast',
  order: 1,
  menuItems: ['Poha'],
  imageUrl: null,
  description: 'Morning meal',
  price: 100,
  attendanceWindowOpen: '07:30',
  attendanceWindowClose: '09:30',
  isActive: true,
  preferencesEnabled: true,
  // Flat tags exist alongside the bound group: the admin attendance / staff
  // attendance / guest sheets read this list on its own, so the freeze must
  // preserve it in BOTH modes (see resolvePublishedPreference).
  enabledPreferences: ['veg', 'egg'],
};

/** One ACTIVE preference group bound to the meal at publish time. */
const groupAtPublish = {
  id: 'pg_staple',
  label: 'Staple',
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

/** Minimal prisma double: one schedule row whose snapshot we capture on write. */
function makePrisma() {
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
    entries: [
      {
        id: 'e1',
        scheduleId: SCHED,
        mealId: MEAL,
        dayOfWeek: 3,
        date: DATE,
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
        meal: { ...masterAtPublish },
      },
    ],
  };
  return {
    row,
    client: {
      mealSchedule: {
        findFirst: jest.fn(async () => row),
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

/** Real narrower — never a stub, so a drift in the canonical rule shows here. */
const pubCtx = {
  resolve: async () => new Map([[MEAL, [groupAtPublish as any]]]),
  narrowByDay: (g: any, o: any) => realPrefs.applyDayOverride(g, o),
} as any;

async function publishWithGroups(prisma: any) {
  const repo = new SchedulesRepository(prisma.client);
  return repo.publish(SCHED, ORG, false, pubCtx);
}

describe('P-01 — published schedule isolation', () => {
  it('PUBLISH freezes the complete effective preference configuration', async () => {
    const prisma = makePrisma();
    await publishWithGroups(prisma);

    const snap = prisma.row.publishedSnapshot;
    expect(Array.isArray(snap)).toBe(true);
    const entry = snap[0];

    expect(entry.configurationFrozen).toBe(true);
    expect(entry.preference.enabled).toBe(true);
    expect(entry.preference.mode).toBe('group');
    // multiple-pick + min/max + priceDelta all frozen, per the spec's list.
    expect(entry.preference.groups[0].selectionType).toBe('multiple');
    expect(entry.preference.groups[0].minSelect).toBe(1);
    expect(entry.preference.groups[0].maxSelect).toBe(2);
    expect(entry.preference.groups[0].options[0].priceDelta).toBe(5);
    // The master block stays frozen alongside it.
    expect(entry.meal.price).toBe(100);
    expect(entry.meal.attendanceWindowOpen).toBe('07:30');
  });

  it('MASTER mutation after publish does NOT move the published day', async () => {
    const prisma = makePrisma();
    await publishWithGroups(prisma);

    // ── The admin now edits MASTER without publishing ────────────────────────
    // Standalone (binding suspended), price ₹100 → ₹150, window moved, renamed.
    prisma.row.entries[0].meal = {
      ...masterAtPublish,
      name: 'Morning Breakfast',
      price: 150,
      attendanceWindowOpen: '08:00',
      attendanceWindowClose: '10:00',
    };

    const day = await resolvePublishedDayEntries(prisma.client, {
      groupId: GROUP,
      organizationId: ORG,
      dateStr: '2026-08-06',
    });
    const e = day.get(MEAL)!;

    expect(e.configurationFrozen).toBe(true);
    // PUBLISHED still says what it said at publish time.
    expect(e.preference!.mode).toBe('group');
    expect(e.meal!.price).toBe(100);
    expect(e.meal!.name).toBe('Breakfast');
    expect(e.meal!.attendanceWindowOpen).toBe('07:30');
  });

  it('the student card is rebased onto the frozen published baseline', async () => {
    const prisma = makePrisma();
    await publishWithGroups(prisma);
    prisma.row.entries[0].meal = { ...masterAtPublish, price: 150 };

    const day = await resolvePublishedDayEntries(prisma.client, {
      groupId: GROUP,
      organizationId: ORG,
      dateStr: '2026-08-06',
    });

    // The LIVE master card the meal list would produce today (₹150, standalone).
    const liveCard = {
      id: MEAL,
      name: 'Morning Breakfast',
      price: 150,
      preferencesEnabled: true,
      enabledPreferences: ['veg'],
      preferenceGroups: [],
      attendanceWindow: { openTime: '08:00', closeTime: '10:00' },
    };

    const card = (MealsService as any).applyDayEntryToMeal(
      liveCard,
      day.get(MEAL),
    );

    expect(card.price).toBe(100);
    expect(card.name).toBe('Breakfast');
    expect(card.attendanceWindow.openTime).toBe('07:30');
    expect(card.preferenceGroups).toHaveLength(1);
    expect(card.preferenceGroups[0].id).toBe('pg_staple');
    // BASELINE FIDELITY: flat tags survive in group mode (admin attendance and
    // the guest sheet read them independently of preferenceGroups) — but they
    // are the FROZEN ones, not the live master's current list.
    expect(card.enabledPreferences).toEqual(['veg', 'egg']);
  });

  it('flat tags are frozen too — a master tag edit does not reach students', async () => {
    const prisma = makePrisma();
    await publishWithGroups(prisma);

    // Admin edits the master tag list without publishing.
    prisma.row.entries[0].meal = {
      ...masterAtPublish,
      enabledPreferences: ['jain'],
    };

    const day = await resolvePublishedDayEntries(prisma.client, {
      groupId: GROUP,
      organizationId: ORG,
      dateStr: '2026-08-06',
    });

    expect(day.get(MEAL)!.preference!.tags).toEqual(['veg', 'egg']);
  });

  it('a snapshot taken before the freeze keeps its historical resolution — never rebuilt', async () => {
    const prisma = makePrisma();
    // A row published by an older build: snapshot present, no version marker,
    // no preference block. This must NOT be promoted or reconstructed.
    prisma.row.publishedAt = new Date();
    prisma.row.publishedSnapshot = [
      {
        mealId: MEAL,
        dayOfWeek: 3,
        date: DATE.toISOString(),
        openTime: null,
        closeTime: null,
        preferencesEnabled: null,
        enabledPreferences: [],
        enabledPreferenceGroupIds: [],
        menuItems: [],
        price: null,
        meal: { ...masterAtPublish },
      },
    ];

    const day = await resolvePublishedDayEntries(prisma.client, {
      groupId: GROUP,
      organizationId: ORG,
      dateStr: '2026-08-06',
    });
    const e = day.get(MEAL)!;

    expect(e.configurationFrozen).toBe(false);
    expect(e.preference).toBeNull();

    // …and the card keeps the LIVE master values, exactly as before the fix.
    const liveCard = {
      id: MEAL,
      name: 'Morning Breakfast',
      price: 150,
      preferencesEnabled: true,
      enabledPreferences: ['veg'],
      preferenceGroups: [{ id: 'pg_new' }],
    };
    const card = (MealsService as any).applyDayEntryToMeal(liveCard, e);
    expect(card.price).toBe(150);
    expect(card.name).toBe('Morning Breakfast');
    expect(card.preferenceGroups).toEqual([{ id: 'pg_new' }]);
  });

  it('Global Meal Preference OFF strips the FROZEN block at publish', async () => {
    const prisma = makePrisma();
    const repo = new SchedulesRepository(prisma.client);
    await repo.publish(SCHED, ORG, /* stripPreferences */ true, pubCtx);

    const entry = prisma.row.publishedSnapshot[0];
    expect(entry.preference.enabled).toBe(false);
    expect(entry.preference.mode).toBe('standalone');
    expect(entry.preference.groups).toEqual([]);
  });

  it('carry-forward obeys the PUBLISHED mode, not the live group flag', async () => {
    // A WEEKLY schedule published with Wednesday deliberately empty
    // (FR-MODE-032 holiday). The admin then switches the group to Day-Wise,
    // which flips `dayWiseMealsEnabled` BEFORE the new mode is published.
    // The published Weekly Wednesday must STAY EMPTY until an actual publish.
    const prisma = makePrisma();
    prisma.row.publishedAt = new Date();
    prisma.row.publishedSnapshot = [
      // Tuesday (2026-08-04) has meals; Wednesday (08-05) deliberately has none.
      {
        configurationFrozen: true,
        plannerMode: 'WEEKLY',
        preference: { enabled: false, mode: 'standalone', tags: [], groups: [] },
        mealId: MEAL,
        dayOfWeek: 1,
        date: new Date(Date.UTC(2026, 7, 4)).toISOString(),
        meal: { ...masterAtPublish },
      },
    ];

    const day = await resolvePublishedDayEntries(
      {
        ...prisma.client,
        // Live flag says DAY-WISE — the mode switch already happened.
        group: { findFirst: async () => ({ dayWiseMealsEnabled: true }) },
      } as any,
      { groupId: GROUP, organizationId: ORG, dateStr: '2026-08-05' },
    );

    expect(day.size).toBe(0); // published Wednesday stays empty

    // Same data published in DAY-WISE mode DOES carry forward.
    prisma.row.publishedSnapshot[0].plannerMode = 'DAY_WISE';
    const carried = await resolvePublishedDayEntries(
      {
        ...prisma.client,
        group: { findFirst: async () => ({ dayWiseMealsEnabled: true }) },
      } as any,
      { groupId: GROUP, organizationId: ORG, dateStr: '2026-08-05' },
    );
    expect(carried.get(MEAL)?.meal?.price).toBe(100);
  });

  it('a published row whose configuration was never frozen is flagged requiresRepublish', async () => {
    const prisma = makePrisma();
    prisma.row.publishedAt = new Date();
    prisma.row.publishedSnapshot = [{ mealId: MEAL, dayOfWeek: 3, date: DATE }];
    const repo = new SchedulesRepository(prisma.client);

    const legacy = await repo.findById(SCHED, ORG);
    expect(legacy!.requiresRepublish).toBe(true);

    // After a real publish it is complete, so the flag clears.
    await publishWithGroups(prisma);
    const fresh = await repo.findById(SCHED, ORG);
    expect(fresh!.requiresRepublish).toBe(false);
  });
});
