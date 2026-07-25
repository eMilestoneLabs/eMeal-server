/**
 * ISSUE-001 — Meal DELETE / DISABLE / GLOBAL MEAL PREFERENCE lifecycle.
 *
 * Positive, negative and corner scenarios for the locked business rules:
 *
 *   DISABLE = temporary. Stays in the Master Meal Template, re-enableable.
 *   DELETE  = permanent. Leaves the template for good, never re-enableable.
 *   Both    = published schedule is NEVER modified; members keep the last
 *             published week until the admin republishes.
 *   History (attendance / billing / reports / published snapshots) is
 *             ALWAYS preserved — the meal ROW is never physically removed.
 *
 * These exercise the repository/service CONTRACTS (which query filters and
 * side-effects fire), not Prisma itself — the same discipline the existing
 * meals.service.spec.ts uses.
 */
import { MealsRepository } from '../repositories/meals.repository';
import { SchedulesRepository } from '../repositories/schedules.repository';

describe('ISSUE-001 meal lifecycle — DELETE / DISABLE / GLOBAL PREFERENCE', () => {
  /** Captures the `where` Prisma receives so filters can be asserted. */
  const repoWith = () => {
    const calls: { findMany: any[]; updateMany: any[]; count: any[] } = {
      findMany: [],
      updateMany: [],
      count: [],
    };
    const repo = new MealsRepository({
      meal: {
        findMany: jest.fn(async (a: any) => {
          calls.findMany.push(a);
          return [];
        }),
        updateMany: jest.fn(async (a: any) => {
          calls.updateMany.push(a);
          return { count: a.where?.deletedAt === null ? 1 : 0 };
        }),
        count: jest.fn(async (a: any) => {
          calls.count.push(a);
          return 0;
        }),
        findFirst: jest.fn(async () => null),
      },
    } as never);
    return { repo, calls };
  };

  describe('DELETE — permanent removal from the template', () => {
    it('POSITIVE: stamps deletedAt (row survives for history)', async () => {
      const { repo, calls } = repoWith();
      await repo.softDelete('meal_01', 'org_01');
      const data = calls.updateMany[0].data;
      expect(data.isActive).toBe(false);
      expect(data.deletedAt).toBeInstanceOf(Date);
      // The row is UPDATED, never deleted — attendance/billing keep resolving it.
      expect(calls.updateMany[0]).not.toHaveProperty('delete');
    });

    it('POSITIVE: a DISABLED meal can be deleted (gate is deletedAt, not isActive)', async () => {
      const { repo, calls } = repoWith();
      await repo.softDelete('meal_01', 'org_01');
      // Gating on isActive:true matched ZERO rows for a disabled meal and
      // failed with "already archived" — that path is now reachable from the
      // template, so the guard must be deletedAt.
      expect(calls.updateMany[0].where).toEqual({
        id: 'meal_01',
        organizationId: 'org_01',
        deletedAt: null,
      });
      expect(calls.updateMany[0].where.isActive).toBeUndefined();
    });

    it('NEGATIVE: deleting an already-deleted meal throws', async () => {
      const repo = new MealsRepository({
        meal: { updateMany: jest.fn(async () => ({ count: 0 })) },
      } as never);
      await expect(repo.softDelete('meal_01', 'org_01')).rejects.toThrow(
        /not found or already deleted/i,
      );
    });

    it('POSITIVE: deleted meals NEVER appear in the template', async () => {
      const { repo, calls } = repoWith();
      await repo.findByGroup('grp_01', 'org_01', { page: 1, limit: 50 });
      expect(calls.findMany[0].where.deletedAt).toBeNull();
    });

    it('CORNER: deleted meals stay hidden even with includeDisabled', async () => {
      const { repo, calls } = repoWith();
      await repo.findByGroup('grp_01', 'org_01', {
        page: 1,
        limit: 50,
        includeDisabled: true,
      });
      // includeDisabled exists to re-enable a DISABLED meal — never to
      // resurrect a deleted one.
      expect(calls.findMany[0].where.deletedAt).toBeNull();
      expect(calls.findMany[0].where.isActive).toBeUndefined();
    });

    it('POSITIVE: history lookup still resolves DELETED meals', async () => {
      const { repo, calls } = repoWith();
      await repo.findByIdsAnyState(['meal_01'], 'grp_01', 'org_01');
      // Published-snapshot rehydration + billing/report joins depend on this:
      // no deletedAt and no isActive filter.
      expect(calls.findMany[0].where.deletedAt).toBeUndefined();
      expect(calls.findMany[0].where.isActive).toBeUndefined();
      expect(calls.findMany[0].where.organizationId).toBe('org_01');
    });
  });

  describe('DISABLE — temporary, reversible', () => {
    it('POSITIVE: disabled meals are LISTED when includeDisabled is set', async () => {
      const { repo, calls } = repoWith();
      await repo.findByGroup('grp_01', 'org_01', {
        page: 1,
        limit: 50,
        includeDisabled: true,
      });
      // No isActive filter → isActive:false (but not deleted) rows come back,
      // which is what makes the Enable button reachable.
      expect(calls.findMany[0].where.isActive).toBeUndefined();
    });

    it('POSITIVE: members/students never see disabled meals', async () => {
      const { repo, calls } = repoWith();
      await repo.findByGroup('grp_01', 'org_01', { page: 1, limit: 50 });
      expect(calls.findMany[0].where.isActive).toBe(true);
    });

    it('CORNER: the active-meal CAP ignores disabled and deleted meals', async () => {
      const { repo, calls } = repoWith();
      await repo.countActiveInGroup('grp_01', 'org_01');
      expect(calls.count[0].where.isActive).toBe(true);
    });

    it('NEGATIVE: name uniqueness ignores archived meals (name is freed)', async () => {
      const repo = new MealsRepository({
        meal: { findFirst: jest.fn(async (a: any) => (a.where.isActive ? null : {})) },
      } as never);
      // Only ACTIVE meals reserve a name, so a deleted meal's name can be
      // reused when recreating it (UNI-016, active-scope).
      await expect(
        repo.existsByNameInGroup('grp_01', 'org_01', 'Lunch'),
      ).resolves.toBe(false);
    });

    it('CORNER: uniqueness probe is case-insensitive and tenant-scoped', async () => {
      let captured: any;
      const repo = new MealsRepository({
        meal: {
          findFirst: jest.fn(async (a: any) => {
            captured = a;
            return null;
          }),
        },
      } as never);
      await repo.existsByNameInGroup('grp_01', 'org_01', 'Lunch', 'meal_01');
      expect(captured.where.name).toEqual({
        equals: 'Lunch',
        mode: 'insensitive',
      });
      expect(captured.where.organizationId).toBe('org_01');
      expect(captured.where.isActive).toBe(true);
      expect(captured.where.id).toEqual({ not: 'meal_01' });
    });
  });

  describe('AUTO-DRAFT triggers — published snapshot must survive', () => {
    const schedRepo = () => {
      const calls: any[] = [];
      const repo = new SchedulesRepository({
        mealSchedule: {
          updateMany: jest.fn(async (a: any) => {
            calls.push(a);
            return { count: 2 };
          }),
        },
      } as never);
      return { repo, calls };
    };

    it('POSITIVE: group revert flips ONLY the draft flag (trigger 1/2/3)', async () => {
      const { repo, calls } = schedRepo();
      const n = await repo.revertPublishedForGroup('grp_01', 'org_01');
      expect(n).toBe(2);
      expect(calls[0].data).toEqual({ isPublished: false });
    });

    it('CORNER: publishedAt / publishedSnapshot are NEVER touched', async () => {
      const { repo, calls } = schedRepo();
      await repo.revertPublishedForGroup('grp_01', 'org_01');
      // Members keep the last published week until the admin republishes, so
      // the revert may only clear the ADMIN-facing draft flag.
      expect(Object.keys(calls[0].data)).toEqual(['isPublished']);
      expect(calls[0].data).not.toHaveProperty('publishedAt');
      expect(calls[0].data).not.toHaveProperty('publishedSnapshot');
    });

    it('CORNER: only ALREADY-PUBLISHED planners are reverted', async () => {
      const { repo, calls } = schedRepo();
      await repo.revertPublishedForGroup('grp_01', 'org_01');
      expect(calls[0].where.isPublished).toBe(true);
    });

    it('TENANT: the revert is group AND org scoped', async () => {
      const { repo, calls } = schedRepo();
      await repo.revertPublishedForGroup('grp_01', 'org_01');
      expect(calls[0].where.organizationId).toBe('org_01');
      expect(calls[0].where.groupId).toBe('grp_01');
    });

    it('POSITIVE: master-meal DELETE purges DRAFT entries only', async () => {
      const calls: any[] = [];
      const repo = new SchedulesRepository({
        scheduleEntry: {
          deleteMany: jest.fn(async (a: any) => {
            calls.push(a);
            return { count: 3 };
          }),
        },
      } as never);
      await repo.deleteDraftEntriesForMeal('meal_01', 'org_01');
      // PUBLISHED rows are untouched — the publish self-heal drops them later.
      expect(calls[0].where.schedule).toEqual({
        organizationId: 'org_01',
        isPublished: false,
      });
    });
  });

  describe('TENANT ISOLATION — every lifecycle query is org-scoped', () => {
    it('delete, list and history lookups all carry organizationId', async () => {
      const { repo, calls } = repoWith();
      await repo.softDelete('meal_01', 'org_01');
      await repo.findByGroup('grp_01', 'org_01', { page: 1, limit: 50 });
      await repo.findByIdsAnyState(['meal_01'], 'grp_01', 'org_01');
      await repo.countActiveInGroup('grp_01', 'org_01');
      expect(calls.updateMany[0].where.organizationId).toBe('org_01');
      expect(calls.findMany[0].where.organizationId).toBe('org_01');
      expect(calls.findMany[1].where.organizationId).toBe('org_01');
      expect(calls.count[0].where.organizationId).toBe('org_01');
    });
  });
});
