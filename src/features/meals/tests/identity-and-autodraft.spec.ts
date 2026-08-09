/**
 * GAP 1 + GAP 3 — auto-draft trigger #3 and historical identity integrity.
 *
 * GAP 1 (PERMANENT_ARCH "AUTO DRAFT TRIGGERS"): the architecture names three
 * unconditional triggers — master meal DELETE, master meal DISABLE, and GLOBAL
 * MEAL PREFERENCE ON/OFF. Only the first two were wired, so toggling the global
 * switch left the planner reporting "Published" with an unpublished change.
 *
 * GAP 3 (historical identity): attendance/exports read the meal label through a
 * LIVE join, so renaming a master meal retroactively relabelled past records.
 * With no per-record name snapshot and no schema change authorised, the rename
 * is stopped once history exists — the admin creates a NEW meal instead, which
 * IS the new identity, while the old meal keeps its records.
 */
import { ConflictException } from '@nestjs/common';
import { MealsService } from '../meals.service';

const ORG = 'org_1';
const GROUP = 'grp_1';
const MEAL = 'meal_1';

const existingMeal = {
  id: MEAL,
  organizationId: ORG,
  groupId: GROUP,
  name: 'Breakfast',
  displayName: null,
  slotKey: 'breakfast',
  isActive: true,
  price: 100,
  preferencesEnabled: false,
  enabledPreferences: [],
  attendanceWindowOpen: '07:00',
  attendanceWindowClose: '09:00',
  menuItems: [],
  imageUrl: null,
  description: null,
  order: 0,
  attendanceEnabled: true,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** MealsService with only the collaborators the update path touches. */
function makeService(historyCount: number) {
  const mealsRepo: any = {
    findById: jest.fn(async () => ({ ...existingMeal })),
    countHistoricalRecords: jest.fn(async () => historyCount),
    update: jest.fn(async (_id: string, _org: string, data: any) => ({
      ...existingMeal,
      ...data,
    })),
    findByGroup: jest.fn(async () => ({ data: [], total: 0 })),
    // MMT-003 duplicate-name guard runs before the identity guard.
    existsByNameInGroup: jest.fn(async () => false),
    getOrganizationTimezone: jest.fn(async () => 'Asia/Kolkata'),
  };
  const groupsRepo: any = {
    findById: jest.fn(async () => ({
      id: GROUP,
      organizationId: ORG,
      mealsEnabled: true,
      mealPricingEnabled: true,
    })),
    findByIdConfig: jest.fn(async () => ({
      id: GROUP,
      organizationId: ORG,
      mealsEnabled: true,
      mealPricingEnabled: true,
    })),
  };
  const schedulesRepo: any = {
    revertPublishedForGroup: jest.fn(async () => 1),
    revertPublishedForMeal: jest.fn(async () => 1),
  };
  const svc = new MealsService(
    mealsRepo,
    groupsRepo,
    schedulesRepo,
    { log: jest.fn() } as any,
    {} as any,
    { getEffectiveGroupsForMeals: jest.fn(async () => new Map()) } as any,
    { get: (_k: string, d: any) => d } as any,
  );
  return { svc, mealsRepo, schedulesRepo };
}

describe('GAP 3 — historical identity integrity', () => {
  it('BLOCKS a rename once the meal has attendance history', async () => {
    const { svc, mealsRepo } = makeService(7);
    await expect(
      svc.updateMeal(MEAL, ORG, 'admin', { name: 'Morning Breakfast' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    // The write never happened — history cannot be relabelled.
    expect(mealsRepo.update).not.toHaveBeenCalled();
  });

  it('BLOCKS a displayName change too (it is what history renders)', async () => {
    const { svc, mealsRepo } = makeService(3);
    await expect(
      svc.updateMeal(MEAL, ORG, 'admin', { displayName: 'Morning' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mealsRepo.update).not.toHaveBeenCalled();
  });

  it('ALLOWS the rename while the meal has NO history (typo fix)', async () => {
    const { svc, mealsRepo } = makeService(0);
    await svc.updateMeal(MEAL, ORG, 'admin', {
      name: 'Morning Breakfast',
    } as any);
    expect(mealsRepo.update).toHaveBeenCalled();
    expect(mealsRepo.update.mock.calls[0][2].name).toBe('Morning Breakfast');
  });

  it('does NOT run the history probe for a non-identity patch (zero cost)', async () => {
    const { svc, mealsRepo } = makeService(99);
    await svc.updateMeal(MEAL, ORG, 'admin', { price: 150 } as any);
    expect(mealsRepo.countHistoricalRecords).not.toHaveBeenCalled();
    expect(mealsRepo.update).toHaveBeenCalled();
  });

  it('a no-op rename (same name) is not treated as an identity change', async () => {
    const { svc, mealsRepo } = makeService(99);
    await svc.updateMeal(MEAL, ORG, 'admin', { name: 'Breakfast' } as any);
    expect(mealsRepo.countHistoricalRecords).not.toHaveBeenCalled();
    expect(mealsRepo.update).toHaveBeenCalled();
  });
});
