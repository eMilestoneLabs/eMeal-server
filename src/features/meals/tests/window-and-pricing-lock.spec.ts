import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GroupsService } from '../../groups/groups.service';
import { GroupsRepository } from '../../groups/repositories/groups.repository';
import { MembersRepository } from '../../groups/repositories/members.repository';
import { UsersRepository } from '../../users/repositories/users.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { GroupEntity } from '../../groups/entities/group.entity';
import { GroupSerializer } from '../../groups/serializers/group.serializer';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { assertMealWindowsValid } from '../utils/window-conflict.util';
import { GENERAL_ATTENDANCE_SLOT_KEY } from '../serializers/meal.serializer';
import { CreateScheduleEntryDto } from '../dto/create-schedule.dto';

/**
 * Live-Test-16 — regression guards for the two locked invariants.
 *
 *   ISSUE-1  First successful schedule publication permanently freezes the
 *            group's Meal-Pricing ON/OFF mode.
 *   ISSUE-2  Every admin-configured attendance window is mandatory and
 *            same-day. (The original no-overlap rule and the 1-hour minimum
 *            gap were WITHDRAWN on 2026-08-03 — any number of CONCURRENT
 *            windows is now allowed by design.)
 *
 * Each test below was mutation-verified: the corresponding production guard was
 * deliberately broken and the test failed. The trap that matters most is the
 * same-value pricing echo — Flutter PATCHes the WHOLE mealConfig on every
 * unrelated toggle, so a naive presence-based lock would break the app.
 */

const win = (
  mealId: string,
  label: string,
  openTime: string | null,
  closeTime: string | null,
  slotKey?: string,
) => ({ mealId, label, openTime, closeTime, slotKey });

describe('Live-Test-16 ISSUE-2 — attendance window rules', () => {
  it('accepts a valid same-day window', () => {
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', '07:00', '09:00')]),
    ).not.toThrow();
  });

  it('rejects a missing window (Q2 — a window is mandatory)', () => {
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', null, null)]),
    ).toThrow(/needs an attendance window/i);
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', '07:00', null)]),
    ).toThrow(/needs an attendance window/i);
  });

  it('rejects an overnight window (Q7 — must open and close same day)', () => {
    expect(() =>
      assertMealWindowsValid([win('m1', 'Midnight Meal', '23:00', '01:00')]),
    ).toThrow(/same day/i);
  });

  it('rejects close == open', () => {
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', '08:00', '08:00')]),
    ).toThrow(/same day/i);
  });

  // WITHDRAWN 2026-08-03 (user decision): the no-overlap rule and the minimum
  // 1-hour gap were removed. An admin may now schedule ANY NUMBER of
  // CONCURRENT windows — e.g. every meal open 07:00-09:00 so members declare
  // the whole day in one morning session.
  it('ALLOWS fully concurrent windows (identical times)', () => {
    expect(() =>
      assertMealWindowsValid([
        win('m1', 'Breakfast', '07:00', '09:00'),
        win('m2', 'Lunch', '07:00', '09:00'),
        win('m3', 'Dinner', '07:00', '09:00'),
      ]),
    ).not.toThrow();
  });

  it('ALLOWS partial overlap and back-to-back windows', () => {
    expect(() =>
      assertMealWindowsValid([
        win('m1', 'Breakfast', '07:00', '10:00'),
        win('m2', 'Lunch', '09:00', '12:00'),
        win('m3', 'Snack', '12:00', '13:00'),
      ]),
    ).not.toThrow();
  });

  it('ALLOWS a gap far under an hour (the 1-hour rule is gone)', () => {
    expect(() =>
      assertMealWindowsValid([
        win('m1', 'Breakfast', '07:00', '09:00'),
        win('m2', 'Lunch', '09:01', '11:00'),
      ]),
    ).not.toThrow();
  });

  it('still validates EVERY window in a concurrent set', () => {
    expect(() =>
      assertMealWindowsValid([
        win('m1', 'Breakfast', '07:00', '09:00'),
        win('m2', 'Lunch', '07:00', '09:00'),
        win('m3', 'Dinner', null, null), // invalid one hides in the middle
      ]),
    ).toThrow(/"Dinner" needs an attendance window/i);
  });

  it('EXEMPTS the implicit __general__ slot (Attendance-Only internals)', () => {
    expect(() =>
      assertMealWindowsValid([
        win('gen', 'Daily Attendance', null, null, GENERAL_ATTENDANCE_SLOT_KEY),
        win('m1', 'Breakfast', '07:00', '09:00'),
      ]),
    ).not.toThrow();
  });
});

describe('Live-Test-16 F1 — calendar-date guard', () => {
  const dateErrors = (date: string) => {
    const dto = plainToInstance(CreateScheduleEntryDto, {
      mealId: 'meal_01',
      date,
    });
    return validateSync(dto).filter((e) => e.property === 'date');
  };

  it('accepts YYYY-MM-DD (the only format parseLocalDate supports)', () => {
    expect(dateErrors('2026-08-03')).toHaveLength(0);
  });

  it('REJECTS a full ISO datetime that would become an Invalid Date', () => {
    const errs = dateErrors('2026-08-03T00:00:00.000Z');
    expect(errs).toHaveLength(1);
    expect(JSON.stringify(errs)).toContain('YYYY-MM-DD');
  });

  it('REJECTS obvious malformed dates', () => {
    expect(dateErrors('03-08-2026').length).toBeGreaterThan(0);
    expect(dateErrors('not-a-date').length).toBeGreaterThan(0);
  });

  it('proves the parser really cannot handle the rejected form', () => {
    const parse = (s: string) => {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    };
    expect(isNaN(parse('2026-08-03T00:00:00.000Z').getTime())).toBe(true);
    expect(parse('2026-08-03').toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });
});

describe('Live-Test-16 ISSUE-1 — permanent Meal-Pricing lock', () => {
  let service: GroupsService;
  let groupsRepo: jest.Mocked<GroupsRepository>;

  const group = (over: Partial<GroupEntity> = {}) =>
    new GroupEntity({
      id: 'grp_01',
      organizationId: 'org_01',
      name: 'Test Hostel',
      type: 'hostel',
      description: null,
      adminId: 'usr_admin',
      joinToken: 'HTL3K8XZ',
      joinTokenExpiresAt: null,
      maxMembers: null,
      isActive: true,
      mealsEnabled: true,
      weeklyMenuEnabled: true,
      preferencesEnabled: false,
      enabledPreferences: [],
      vacationModeEnabled: true,
      mealPricingEnabled: true,
      memberCount: 1,
      memberIds: ['usr_admin'],
      blockedMemberIds: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...over,
    } as any);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupsService,
        {
          provide: GroupsRepository,
          useValue: {
            findById: jest.fn(),
            update: jest.fn(),
            getDetailNames: jest
              .fn()
              .mockResolvedValue({ adminName: null, organizationName: null }),
          },
        },
        { provide: MembersRepository, useValue: {} },
        { provide: UsersRepository, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();
    service = module.get(GroupsService);
    groupsRepo = module.get(GroupsRepository);
  });

  const patch = (mealConfig: Record<string, unknown>) =>
    service.updateGroup('grp_01', 'org_01', 'usr_admin', { mealConfig } as any);

  it('BLOCKS turning pricing OFF after the first publish', async () => {
    groupsRepo.findById.mockResolvedValue(
      group({ firstSchedulePublishedAt: new Date('2026-07-01') } as any),
    );

    await expect(patch({ mealPricingEnabled: false })).rejects.toMatchObject({
      response: { code: 'MEAL_PRICING_LOCKED' },
    });
    expect(groupsRepo.update).not.toHaveBeenCalled();
  });

  it('BLOCKS turning pricing ON after the first publish', async () => {
    groupsRepo.findById.mockResolvedValue(
      group({
        mealPricingEnabled: false,
        firstSchedulePublishedAt: new Date('2026-07-01'),
      } as any),
    );

    await expect(patch({ mealPricingEnabled: true })).rejects.toMatchObject({
      response: { code: 'MEAL_PRICING_LOCKED' },
    });
    expect(groupsRepo.update).not.toHaveBeenCalled();
  });

  it('THE TRAP: a same-value echo on a LOCKED group still succeeds', async () => {
    // Flutter PATCHes the ENTIRE mealConfig for every unrelated toggle, so the
    // current pricing value is re-sent constantly. If the lock compared
    // presence instead of change, every vacation/guest/meals toggle would 400.
    const locked = group({
      firstSchedulePublishedAt: new Date('2026-07-01'),
    } as any);
    groupsRepo.findById.mockResolvedValue(locked);
    groupsRepo.update.mockResolvedValue(locked);

    await expect(
      patch({ mealPricingEnabled: true, vacationRequiresApproval: true }),
    ).resolves.toBeDefined();
    expect(groupsRepo.update).toHaveBeenCalled();
  });

  it('ALLOWS the flip before the first publish (unlocked lifecycle)', async () => {
    const unlocked = group({ mealPricingEnabled: false });
    groupsRepo.findById.mockResolvedValue(unlocked);
    groupsRepo.update.mockResolvedValue(unlocked);

    await expect(patch({ mealPricingEnabled: true })).resolves.toBeDefined();
    expect(groupsRepo.update).toHaveBeenCalledWith(
      'grp_01',
      'org_01',
      expect.objectContaining({ mealPricingEnabled: true }),
    );
  });

  // F2: the client must validate against the SAME gap the server enforces —
  // a hardcoded client value would either warn late (gap raised) or block a
  // configuration the backend accepts (gap lowered).
  it('serializes mealPricingLocked from firstSchedulePublishedAt', () => {
    expect(
      (GroupSerializer.toResponse(group()) as any).mealConfig.mealPricingLocked,
    ).toBe(false);
    expect(
      (
        GroupSerializer.toResponse(
          group({ firstSchedulePublishedAt: new Date('2026-07-01') } as any),
        ) as any
      ).mealConfig.mealPricingLocked,
    ).toBe(true);
  });
});
