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
 *   ISSUE-2  Every admin-configured attendance window is mandatory, same-day,
 *            non-overlapping, and separated from its neighbours by the
 *            configured minimum gap (default 60 minutes).
 *
 * Each test below was mutation-verified: the corresponding production guard was
 * deliberately broken and the test failed. The two that matter most are the
 * traps — the same-value pricing echo (Flutter PATCHes the WHOLE mealConfig on
 * every unrelated toggle, so a naive lock would break the app) and the exact
 * 60-minute boundary (60 must pass, 59 must fail).
 */

const win = (
  mealId: string,
  label: string,
  openTime: string | null,
  closeTime: string | null,
  slotKey?: string,
) => ({ mealId, label, openTime, closeTime, slotKey });

describe('Live-Test-16 ISSUE-2 — attendance window invariant', () => {
  const GAP = 60;

  it('allows an exactly 1-hour gap (boundary: 60 is valid)', () => {
    expect(() =>
      assertMealWindowsValid(
        [
          win('m1', 'Breakfast', '07:00', '09:00'),
          win('m2', 'Lunch', '10:00', '12:00'),
        ],
        GAP,
      ),
    ).not.toThrow();
  });

  it('rejects 59 minutes (boundary: one minute short)', () => {
    expect(() =>
      assertMealWindowsValid(
        [
          win('m1', 'Breakfast', '07:00', '09:00'),
          win('m2', 'Lunch', '09:59', '12:00'),
        ],
        GAP,
      ),
    ).toThrow(/minimum 1-hour gap/i);
  });

  it('reports the earliest allowed start on a gap violation', () => {
    try {
      assertMealWindowsValid(
        [
          win('m1', 'Breakfast', '07:00', '09:00'),
          win('m2', 'Lunch', '09:30', '11:30'),
        ],
        GAP,
      );
      throw new Error('expected a conflict');
    } catch (e: any) {
      expect(e.response?.code).toBe('MEAL_WINDOW_CONFLICT');
      expect(e.response?.errors).toMatchObject({
        reason: 'gap',
        conflictingMeal: 'Breakfast',
        earliestAllowedStart: '10:00',
      });
    }
  });

  it('rejects a direct overlap', () => {
    expect(() =>
      assertMealWindowsValid(
        [
          win('m1', 'Breakfast', '07:00', '10:00'),
          win('m2', 'Lunch', '09:00', '12:00'),
        ],
        GAP,
      ),
    ).toThrow(/overlaps/i);
  });

  it('rejects a fully CONTAINED window (sorting alone would miss it)', () => {
    // 08:00–09:00 sits entirely inside 07:00–12:00. Comparing only against the
    // previous row by open-time would pass this; comparing against the running
    // latest close catches it.
    expect(() =>
      assertMealWindowsValid(
        [
          win('m1', 'All Day', '07:00', '12:00'),
          win('m2', 'Snack', '08:00', '09:00'),
        ],
        GAP,
      ),
    ).toThrow(/overlaps/i);
  });

  it('rejects a missing window (Q2 — a window is mandatory)', () => {
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', null, null)], GAP),
    ).toThrow(/needs an attendance window/i);
  });

  it('rejects an overnight window (Q7 — must open and close same day)', () => {
    expect(() =>
      assertMealWindowsValid([win('m1', 'Midnight Meal', '23:00', '01:00')], GAP),
    ).toThrow(/same day/i);
  });

  it('EXEMPTS the implicit __general__ slot (Attendance-Only internals)', () => {
    // The system slot is deliberately window-less. It must never be validated,
    // and must never block a real meal beside it.
    expect(() =>
      assertMealWindowsValid(
        [
          win('gen', 'Daily Attendance', null, null, GENERAL_ATTENDANCE_SLOT_KEY),
          win('m1', 'Breakfast', '07:00', '09:00'),
        ],
        GAP,
      ),
    ).not.toThrow();
  });

  // L1: a window that will belong to an INACTIVE meal still has to be
  // well-formed — it just isn't gap-checked against active siblings.
  it('L1: a lone window is still presence/same-day checked (no siblings)', () => {
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', null, null)], GAP),
    ).toThrow(/needs an attendance window/i);
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', '22:00', '02:00')], GAP),
    ).toThrow(/same day/i);
    // …and a single VALID window passes with no cross-meal check.
    expect(() =>
      assertMealWindowsValid([win('m1', 'Breakfast', '07:00', '09:00')], GAP),
    ).not.toThrow();
  });

  it('honours a non-default configured gap (nothing is hardcoded)', () => {
    // 10:00 clears a 09:00 close by 60 min — fine at 60, a violation at 90.
    const windows = [
      win('m1', 'Breakfast', '07:00', '09:00'),
      win('m2', 'Lunch', '10:00', '12:00'),
    ];
    expect(() => assertMealWindowsValid(windows, 60)).not.toThrow();
    expect(() => assertMealWindowsValid(windows, 90)).toThrow(
      /minimum 90-minute gap/i,
    );
  });
});

/**
 * F1: `@IsDateString()` alone also accepts a FULL ISO datetime, but
 * `parseLocalDate` handles only `YYYY-MM-DD` — a full ISO string became an
 * Invalid Date whose `toISOString()` throws a RangeError (HTTP 500). The added
 * `@Matches(CALENDAR_DATE_RE)` turns that into a clean 400 (guidebook §4).
 * The constraint is ADDITIVE: only already-broken requests are newly rejected.
 */
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
  it('F2: exposes the EFFECTIVE window gap in the group payload', () => {
    const mc = (GroupSerializer.toResponse(group()) as any).mealConfig;
    expect(mc.windowMinGapMinutes).toBe(60);
  });

  // A malformed env value used to yield NaN, and every comparison against NaN
  // is false — the minimum-gap rule would silently stop being enforced while
  // the overlap check kept working. The resolver now fails CLOSED.
  it.each(['abc', '60min', '', '-5'])(
    'F2: a malformed env value (%p) falls back to 60, never NaN',
    (bad) => {
      const prev = process.env.MEALS_WINDOW_MIN_GAP_MINUTES;
      process.env.MEALS_WINDOW_MIN_GAP_MINUTES = bad;
      try {
        const mc = (GroupSerializer.toResponse(group()) as any).mealConfig;
        expect(Number.isFinite(mc.windowMinGapMinutes)).toBe(true);
        expect(mc.windowMinGapMinutes).toBe(60);
      } finally {
        if (prev === undefined) delete process.env.MEALS_WINDOW_MIN_GAP_MINUTES;
        else process.env.MEALS_WINDOW_MIN_GAP_MINUTES = prev;
      }
    },
  );

  it('F2: the exposed gap follows the env override', () => {
    const prev = process.env.MEALS_WINDOW_MIN_GAP_MINUTES;
    process.env.MEALS_WINDOW_MIN_GAP_MINUTES = '90';
    try {
      const mc = (GroupSerializer.toResponse(group()) as any).mealConfig;
      expect(mc.windowMinGapMinutes).toBe(90);
    } finally {
      if (prev === undefined) delete process.env.MEALS_WINDOW_MIN_GAP_MINUTES;
      else process.env.MEALS_WINDOW_MIN_GAP_MINUTES = prev;
    }
  });

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
