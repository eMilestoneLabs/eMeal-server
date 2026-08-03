import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PreferencesService } from '../../preferences/preferences.service';
import { MealsService } from '../meals.service';
import { MealsRepository } from '../repositories/meals.repository';
import { SchedulesRepository } from '../repositories/schedules.repository';
import { GroupsRepository } from '../../groups/repositories/groups.repository';
import { AuditService } from '../../../audit/audit.service';
import { StorageService } from '../../../storage/storage.service';
import { MealEntity } from '../entities/meal.entity';
import { GroupEntity } from '../../groups/entities/group.entity';

/**
 * MealsService unit tests.
 *
 * Tests verify:
 * - Org isolation: cross-org access rejected
 * - Dynamic rendering: no slotKey enum assumptions
 * - Soft delete: isActive=false, not hard delete
 * - Attendance independence: attendanceEnabled separate from isEnabled
 * - Preference rendering: preferences array always present
 * - Pagination contract: { data, total, page, limit }
 */
describe('MealsService', () => {
  let service: MealsService;
  let mealsRepo: jest.Mocked<MealsRepository>;
  let groupsRepo: jest.Mocked<GroupsRepository>;
  let schedulesRepo: jest.Mocked<SchedulesRepository>;
  let auditService: jest.Mocked<AuditService>;

  const mockGroup = new GroupEntity({
    id: 'grp_01',
    organizationId: 'org_01',
    name: 'Boys Block A',
    type: 'hostel',
    isActive: true,
    joinToken: 'HTL3K8XZ',
    mealsEnabled: true,
    weeklyMenuEnabled: true,
    preferencesEnabled: true,
    enabledPreferences: ['veg', 'chicken'],
    vacationModeEnabled: true,
    memberCount: 5,
    memberIds: [],
    blockedMemberIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const mockGroupMealsDisabled = new GroupEntity({
    ...mockGroup,
    mealsEnabled: false,
  });

  const mockMeal = new MealEntity({
    id: 'meal_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    slotKey: 'breakfast',
    name: 'Morning Meal',
    displayName: 'Breakfast',
    order: 0,
    isActive: true,
    attendanceEnabled: true,
    enabledPreferences: ['veg', 'egg'],
    preferencesEnabled: true,
    attendanceWindowOpen: '06:00',
    attendanceWindowClose: '09:00',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MealsService,
        {
          provide: PreferencesService,
          useValue: {
            getEffectiveGroupsForMeal: jest.fn().mockResolvedValue([]),
            getEffectiveGroupsForMeals: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: MealsRepository,
          useValue: {
            findById: jest.fn(),
            findByGroup: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            softDelete: jest.fn(),
            reorder: jest.fn(),
            verifyGroupOwnership: jest.fn(),
            // SRS MMT-001/003 guards — permissive defaults keep the existing
            // create/update tests on the happy path.
            countActiveInGroup: jest.fn().mockResolvedValue(0),
            existsByNameInGroup: jest.fn().mockResolvedValue(false),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (_key: string, def?: unknown) => def,
            ),
          },
        },
        {
          provide: SchedulesRepository,
          useValue: {
            // Planner overlay is empty by default — tests exercise the plain
            // master-meal path unless they override this mock.
            findTodayOverlay: jest.fn().mockResolvedValue(new Map()),
            // MMT-011: delete-time draft purge (no drafts in unit tests).
            deleteDraftEntriesForMeal: jest.fn().mockResolvedValue(0),
            // Live-Test-9 ISSUE-002: published planners carrying a deleted
            // meal auto-flip to draft (snapshot intact until republish).
            revertPublishedForMeal: jest.fn().mockResolvedValue(0),
            deleteEntriesByIds: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: GroupsRepository,
          useValue: {
            findById: jest.fn(),
            // command_6 perf: getMeals now tenant-gates via the light
            // existence probe (run concurrently with the list query).
            existsInOrg: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: AuditService,
          useValue: { log: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: {
            // Image paths are not exercised in these unit tests.
            uploadImage: jest.fn(),
            deleteImage: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MealsService>(MealsService);
    mealsRepo = module.get(MealsRepository);
    groupsRepo = module.get(GroupsRepository);
    schedulesRepo = module.get(SchedulesRepository);
    auditService = module.get(AuditService);
  });

  // ── CREATE MEAL ─────────────────────────────────────────────────────────

  describe('createMeal', () => {
    it('throws NotFoundException when group not found in org (isolation check)', async () => {
      groupsRepo.findById.mockResolvedValue(null);

      await expect(
        service.createMeal('usr_admin', 'org_01', {
          groupId: 'grp_ATTACKER',
          slotKey: 'breakfast',
          name: 'Test',
        }),
      ).rejects.toThrow(NotFoundException);

      // Verify org isolation — findById called with org from JWT, not attacker's group
      expect(groupsRepo.findById).toHaveBeenCalledWith('grp_ATTACKER', 'org_01');
    });

    it('throws BadRequestException when group has mealsEnabled=false', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroupMealsDisabled);

      await expect(
        service.createMeal('usr_admin', 'org_01', {
          groupId: 'grp_01',
          slotKey: 'lunch',
          name: 'Lunch Meal',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    // L2: `__general__` is a reserved SYSTEM slot (created only by
    // ensureGeneralSlot, exempt from the meal cap and the window invariant).
    // Accepting it here would mint a cap-free, window-free meal.
    it('L2: REJECTS the reserved __general__ slot key', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);

      await expect(
        service.createMeal('usr_admin', 'org_01', {
          groupId: 'grp_01',
          slotKey: '__general__',
          name: 'Sneaky',
          attendanceWindow: { openTime: '07:00', closeTime: '09:00' },
        }),
      ).rejects.toMatchObject({
        response: { code: 'MEAL_SLOT_KEY_RESERVED' },
      });

      expect(mealsRepo.create).not.toHaveBeenCalled();
    });

    it('creates meal with free-form slotKey (not enum)', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.create.mockResolvedValue(mockMeal);

      const result = await service.createMeal('usr_admin', 'org_01', {
        groupId: 'grp_01',
        slotKey: 'iftar',  // custom slot — not in any enum
        name: 'Iftar Meal',
        displayName: 'Iftar',
        // Live-Test-16 ISSUE-2: an attendance window is now mandatory on every
        // admin-created meal. Unrelated to what this test asserts (slotKey
        // passthrough) — supplied so the create reaches the repo.
        attendanceWindow: { openTime: '18:00', closeTime: '19:30' },
      });

      // Verify slotKey passed through as-is (no enum validation)
      expect(mealsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ slotKey: 'iftar' }),
      );
    });

    it('serializes response with isActive (locked Meal contract)', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.create.mockResolvedValue(mockMeal);

      const result = await service.createMeal('usr_admin', 'org_01', {
        groupId: 'grp_01',
        slotKey: 'breakfast',
        name: 'Test',
        // Live-Test-16 ISSUE-2: mandatory window (see note above).
        attendanceWindow: { openTime: '07:00', closeTime: '09:00' },
      });

      expect(result).toHaveProperty('isActive', true);
      expect(result).not.toHaveProperty('isEnabled');
    });

    it('serializes attendanceWindow as nested object', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.create.mockResolvedValue(mockMeal);

      const result = await service.createMeal('usr_admin', 'org_01', {
        groupId: 'grp_01',
        slotKey: 'breakfast',
        name: 'Test',
        attendanceWindow: { openTime: '06:00', closeTime: '09:00' },
      });

      expect(result.attendanceWindow).toEqual({ openTime: '06:00', closeTime: '09:00' });
    });
  });

  // ── GET MEALS ─────────────────────────────────────────────────────────

  describe('getMeals', () => {
    it('throws BadRequestException when groupId is missing', async () => {
      await expect(
        service.getMeals('usr_admin', 'hostelAdmin', 'org_01', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns paginated response with { data, total, page, limit }', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.findByGroup.mockResolvedValue({
        data: [mockMeal],
        total: 1,
        page: 1,
        limit: 20,
      });

      const result = await service.getMeals('usr_admin', 'hostelAdmin', 'org_01', {
        groupId: 'grp_01',
      });

      // CRITICAL: Flutter reads these exact keys
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 20);

      // Must never use non-standard keys
      expect(result).not.toHaveProperty('items');
      expect(result).not.toHaveProperty('results');
      expect(result).not.toHaveProperty('count');
      expect(result).not.toHaveProperty('pageSize');
    });

    it('student only sees enabled meals (includeDisabled=false)', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.findByGroup.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });

      await service.getMeals('usr_student', 'student', 'org_01', {
        groupId: 'grp_01',
      });

      expect(mealsRepo.findByGroup).toHaveBeenCalledWith(
        'grp_01',
        'org_01',
        expect.objectContaining({ includeDisabled: false }),
      );
    });
  });

  // ── UPDATE MEAL ─────────────────────────────────────────────────────────

  describe('updateMeal', () => {
    it('throws NotFoundException when meal not found in org', async () => {
      mealsRepo.findById.mockResolvedValue(null);

      await expect(
        service.updateMeal('meal_999', 'org_01', 'usr_admin', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('maps isEnabled → isActive in update payload', async () => {
      mealsRepo.findById.mockResolvedValue(mockMeal);
      mealsRepo.update.mockResolvedValue({ ...mockMeal, isActive: false });

      await service.updateMeal('meal_01', 'org_01', 'usr_admin', {
        isEnabled: false,
      });

      expect(mealsRepo.update).toHaveBeenCalledWith(
        'meal_01',
        'org_01',
        expect.objectContaining({ isActive: false }),
      );
      // Must NOT pass isEnabled to repo (repo uses isActive)
      expect(mealsRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ isEnabled: expect.anything() }),
      );
    });

    // L1: disabling a meal AND clearing/breaking its window in one PATCH used
    // to skip validation entirely (an inactive meal has no siblings to clash
    // with), so a disabled meal could bank an invalid window that only
    // surfaced on re-enable. The window itself is now always well-formed.
    it('L1: REJECTS an invalid window even when the meal is being disabled', async () => {
      mealsRepo.findById.mockResolvedValue(mockMeal);
      mealsRepo.update.mockResolvedValue(mockMeal);

      await expect(
        service.updateMeal('meal_01', 'org_01', 'usr_admin', {
          isEnabled: false,
          attendanceWindow: null,
        }),
      ).rejects.toMatchObject({
        response: { code: 'MEAL_WINDOW_REQUIRED' },
      });

      expect(mealsRepo.update).not.toHaveBeenCalled();
    });

    // Live-Test-16 ISSUE-2 (user-locked Q2): clearing a window used to be
    // allowed and the missing window was then read as "open all day". Every
    // admin-configured meal now REQUIRES a window, so this previously-positive
    // test is inverted: the clear must be refused and nothing may be written.
    it('REJECTS clearing attendanceWindow — a window is mandatory', async () => {
      mealsRepo.findById.mockResolvedValue(mockMeal);
      mealsRepo.update.mockResolvedValue(mockMeal);

      await expect(
        service.updateMeal('meal_01', 'org_01', 'usr_admin', {
          attendanceWindow: null,
        }),
      ).rejects.toMatchObject({
        response: { code: 'MEAL_WINDOW_REQUIRED' },
      });

      expect(mealsRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── DELETE (soft) ──────────────────────────────────────────────────────

  describe('deleteMeal (soft)', () => {
    it('calls softDelete (never hard delete)', async () => {
      mealsRepo.softDelete.mockResolvedValue(undefined);

      const result = await service.deleteMeal('meal_01', 'org_01', 'usr_admin');

      expect(mealsRepo.softDelete).toHaveBeenCalledWith('meal_01', 'org_01');
      expect(result).toHaveProperty('message', 'Meal archived successfully');
      // Live-Test-9 ISSUE-002: draft entries purged AND published planners
      // carrying the meal reverted to draft — members keep the frozen
      // published snapshot until the admin republishes.
      expect(schedulesRepo.deleteDraftEntriesForMeal).toHaveBeenCalledWith(
        'meal_01',
        'org_01',
      );
      expect(schedulesRepo.revertPublishedForMeal).toHaveBeenCalledWith(
        'meal_01',
        'org_01',
      );
    });
  });

  // ── ISSUE-001 lifecycle scenarios (delete / disable / re-enable) ────────

  describe('ISSUE-001 enable rules (positive / negative / corner)', () => {
    const disabledMeal = { ...mockMeal, isActive: false, deletedAt: null } as any;
    const deletedMeal = {
      ...mockMeal,
      isActive: false,
      deletedAt: new Date('2026-07-20T00:00:00.000Z'),
    } as any;

    it('NEGATIVE: a DELETED meal can never be re-enabled', async () => {
      mealsRepo.findById.mockResolvedValue(deletedMeal);

      await expect(
        service.updateMeal('meal_01', 'org_01', 'usr_admin', {
          isEnabled: true,
        }),
      ).rejects.toThrow(/deleted and cannot be enabled/i);
      // Rejected BEFORE any write.
      expect(mealsRepo.update).not.toHaveBeenCalled();
    });

    it('NEGATIVE: re-enabling past the cap is rejected with a reason', async () => {
      mealsRepo.findById.mockResolvedValue(disabledMeal);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.countActiveInGroup.mockResolvedValue(10); // cap reached

      await expect(
        service.updateMeal('meal_01', 'org_01', 'usr_admin', {
          isEnabled: true,
        }),
      ).rejects.toThrow(/at most 10/i);
      expect(mealsRepo.update).not.toHaveBeenCalled();
    });

    it('NEGATIVE: re-enabling into a taken ACTIVE name is a conflict', async () => {
      mealsRepo.findById.mockResolvedValue(disabledMeal);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.countActiveInGroup.mockResolvedValue(1);
      mealsRepo.existsByNameInGroup.mockResolvedValue(true);

      await expect(
        service.updateMeal('meal_01', 'org_01', 'usr_admin', {
          isEnabled: true,
        }),
      ).rejects.toThrow(/already exists/i);
      expect(mealsRepo.update).not.toHaveBeenCalled();
    });

    it('POSITIVE: a DISABLED meal re-enables under the cap', async () => {
      mealsRepo.findById.mockResolvedValue(disabledMeal);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.countActiveInGroup.mockResolvedValue(1);
      mealsRepo.existsByNameInGroup.mockResolvedValue(false);
      mealsRepo.update.mockResolvedValue({ ...mockMeal, isActive: true });

      await service.updateMeal('meal_01', 'org_01', 'usr_admin', {
        isEnabled: true,
      });

      expect(mealsRepo.update).toHaveBeenCalledWith(
        'meal_01',
        'org_01',
        expect.objectContaining({ isActive: true }),
      );
    });

    // Live-Test-16 ISSUE-2 (Q2): re-enabling makes the STORED window live
    // again, so it must still satisfy the mandate even when the patch never
    // mentions the window. Only reachable for rows predating the mandate —
    // without this guard such a meal could be switched back on and bypass it.
    it('NEGATIVE: re-enabling a meal with NO stored window is rejected', async () => {
      mealsRepo.findById.mockResolvedValue({
        ...disabledMeal,
        attendanceWindowOpen: null,
        attendanceWindowClose: null,
      });
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.countActiveInGroup.mockResolvedValue(1);
      mealsRepo.existsByNameInGroup.mockResolvedValue(false);

      await expect(
        service.updateMeal('meal_01', 'org_01', 'usr_admin', {
          isEnabled: true,
        }),
      ).rejects.toThrow(/needs an attendance window/i);
      expect(mealsRepo.update).not.toHaveBeenCalled();
    });

    it('NEGATIVE: re-enabling a meal with an OVERNIGHT stored window is rejected', async () => {
      mealsRepo.findById.mockResolvedValue({
        ...disabledMeal,
        attendanceWindowOpen: '23:00',
        attendanceWindowClose: '01:00',
      });
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.countActiveInGroup.mockResolvedValue(1);
      mealsRepo.existsByNameInGroup.mockResolvedValue(false);

      await expect(
        service.updateMeal('meal_01', 'org_01', 'usr_admin', {
          isEnabled: true,
        }),
      ).rejects.toThrow(/same day/i);
      expect(mealsRepo.update).not.toHaveBeenCalled();
    });

    it('CORNER: a NON-enabling patch never re-validates the stored window', async () => {
      // A window-less legacy meal must stay editable (rename, price, image) —
      // the guard fires on RE-ENABLE only, never on an unrelated edit.
      mealsRepo.findById.mockResolvedValue({
        ...disabledMeal,
        attendanceWindowOpen: null,
        attendanceWindowClose: null,
      });
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.update.mockResolvedValue({ ...mockMeal, name: 'Renamed' });
      mealsRepo.existsByNameInGroup.mockResolvedValue(false);

      await service.updateMeal('meal_01', 'org_01', 'usr_admin', {
        name: 'Renamed',
      });

      expect(mealsRepo.update).toHaveBeenCalled();
    });

    it('CORNER: enable/disable flips the GROUP planners to draft (snapshot intact)', async () => {
      // The shared harness omits the group-scoped method on purpose (the
      // deleteMeal test above exercises the meal-scoped fallback). Production
      // HAS it, so inject it to assert the real path.
      (schedulesRepo as any).revertPublishedForGroup = jest.fn(async () => 1);
      mealsRepo.findById.mockResolvedValue(mockMeal);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.update.mockResolvedValue({ ...mockMeal, isActive: false });

      await service.updateMeal('meal_01', 'org_01', 'usr_admin', {
        isEnabled: false,
      });

      // Auto-draft trigger #2 — publishedAt/publishedSnapshot are untouched,
      // so members keep the last published week until republish.
      expect(schedulesRepo.revertPublishedForGroup).toHaveBeenCalledWith(
        'grp_01',
        'org_01',
      );
    });

    it('CORNER: a non-enable edit does NOT flip planners to draft', async () => {
      (schedulesRepo as any).revertPublishedForGroup = jest.fn(async () => 1);
      mealsRepo.findById.mockResolvedValue(mockMeal);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.update.mockResolvedValue(mockMeal);

      await service.updateMeal('meal_01', 'org_01', 'usr_admin', {
        description: 'new text',
      });

      expect(schedulesRepo.revertPublishedForGroup).not.toHaveBeenCalled();
    });
  });

  // ── REORDER ────────────────────────────────────────────────────────────

  describe('reorderMeals', () => {
    it('throws NotFoundException when group not in org', async () => {
      groupsRepo.findById.mockResolvedValue(null);

      await expect(
        service.reorderMeals('org_01', 'usr_admin', {
          groupId: 'grp_UNKNOWN',
          mealIds: ['meal_01'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for empty mealIds', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);

      await expect(
        service.reorderMeals('org_01', 'usr_admin', {
          groupId: 'grp_01',
          mealIds: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls repo.reorder with org-scoped mealIds', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      mealsRepo.reorder.mockResolvedValue(undefined);

      await service.reorderMeals('org_01', 'usr_admin', {
        groupId: 'grp_01',
        mealIds: ['meal_03', 'meal_01', 'meal_02'],
      });

      expect(mealsRepo.reorder).toHaveBeenCalledWith(
        ['meal_03', 'meal_01', 'meal_02'],
        'org_01',
      );
    });
  });
});
