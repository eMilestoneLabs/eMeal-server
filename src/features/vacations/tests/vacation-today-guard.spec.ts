import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { VacationsService } from '../vacations.service';
import { VacationRequestsRepository } from '../repositories/vacation-requests.repository';
import { AuditService } from '../../../audit/audit.service';
import {
  findCoveredTakenMeal,
  TakenMealLite,
} from '../../../common/utils/vacation-coverage.util';
import { getTodayInTimezone } from '../../../common/utils/date.utils';

/**
 * Live-Test-16 ISSUE-2 (vacation only for UPCOMING meals — never a meal
 * already taken today) and ISSUE-19 (a group-scoped request only from an
 * active member of that group).
 */
const meal = (
  id: string,
  slotKey: string,
  open: string,
  groupId = 'g1',
): TakenMealLite => ({ id, groupId, slotKey, name: slotKey, attendanceWindowOpen: open });

const BREAKFAST = meal('m-b', 'breakfast', '07:00');
const LUNCH = meal('m-l', 'lunch', '12:00');
const DINNER = meal('m-d', 'dinner', '19:00');
const ALL = [BREAKFAST, LUNCH, DINNER];
const D = new Date('2098-01-01T00:00:00.000Z');
const range = (start: string | null, end: string | null = null) => ({
  groupId: 'g1',
  startDate: D,
  endDate: D,
  startSlotKey: start,
  endSlotKey: end,
});

describe('findCoveredTakenMeal (pure, ISSUE-2)', () => {
  it('whole day is refused once any meal today was taken', () => {
    expect(findCoveredTakenMeal(range(null), D, [BREAKFAST], ALL)).toBe(BREAKFAST);
  });

  it('starting from Dinner after Breakfast+Lunch were taken is allowed', () => {
    expect(findCoveredTakenMeal(range('dinner'), D, [BREAKFAST, LUNCH], ALL)).toBeNull();
  });

  it('starting from Lunch after Lunch was taken is refused (identity)', () => {
    expect(findCoveredTakenMeal(range('lunch'), D, [LUNCH], ALL)).toBe(LUNCH);
  });

  it('starting from Breakfast when only Dinner was taken is refused (dinner is covered)', () => {
    expect(findCoveredTakenMeal(range('breakfast'), D, [DINNER], ALL)).toBe(DINNER);
  });

  it('nothing taken today → always allowed', () => {
    expect(findCoveredTakenMeal(range(null), D, [], ALL)).toBeNull();
  });

  it('a taken meal of ANOTHER group never ranks against this group\'s slots', () => {
    const other = meal('x-d', 'dinner', '19:00', 'g2');
    // g2's dinner has no g1 boundary slot → identity/time math within g2 only.
    expect(findCoveredTakenMeal(range('dinner'), D, [other], [...ALL, other])).toBe(other);
  });
});

describe('VacationsService.createRequest today/membership guards', () => {
  let service: VacationsService;
  let repo: any;
  const today = getTodayInTimezone('Asia/Kolkata');

  beforeEach(async () => {
    repo = {
      getOrgTimezone: jest.fn().mockResolvedValue('Asia/Kolkata'),
      getUserName: jest.fn().mockResolvedValue('Member'),
      getUserActiveGroupId: jest.fn().mockResolvedValue(null),
      findOverlapping: jest.fn().mockResolvedValue(null),
      hasActiveMembership: jest.fn().mockResolvedValue(true),
      findTodayTakenMeals: jest.fn().mockResolvedValue({ taken: [], groupMeals: ALL }),
      create: jest.fn().mockImplementation(async (d: any) => ({
        id: 'vr1',
        organizationId: 'org1',
        status: 'pending',
        reason: null,
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...d,
      })),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VacationsService,
        { provide: VacationRequestsRepository, useValue: repo },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = module.get(VacationsService);
  });

  it('403 GROUP_MEMBERSHIP_REQUIRED for a group the member does not belong to', async () => {
    repo.hasActiveMembership.mockResolvedValue(false);
    await expect(
      service.createRequest('u1', 'org1', {
        startDate: '2098-01-01',
        endDate: '2098-01-02',
        groupId: 'g-foreign',
      } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(repo.hasActiveMembership).toHaveBeenCalledWith('u1', 'org1', 'g-foreign');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('group-scoped request from an active member is created WITH its groupId', async () => {
    await service.createRequest('u1', 'org1', {
      startDate: '2098-01-01',
      endDate: '2098-01-02',
      groupId: 'g1',
    } as any);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'g1' }));
  });

  it('future-dated requests never run the today guard (zero extra reads)', async () => {
    await service.createRequest('u1', 'org1', {
      startDate: '2098-01-01',
      endDate: '2098-01-02',
      groupId: 'g1',
    } as any);
    expect(repo.findTodayTakenMeals).not.toHaveBeenCalled();
  });

  it('422 VACATION_MEAL_ALREADY_TAKEN for a whole-day request today after a meal was taken', async () => {
    repo.findTodayTakenMeals.mockResolvedValue({ taken: [BREAKFAST], groupMeals: ALL });
    await expect(
      service.createRequest('u1', 'org1', {
        startDate: today,
        endDate: today,
        groupId: 'g1',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VACATION_MEAL_ALREADY_TAKEN' }),
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('today from Dinner after Breakfast+Lunch were taken is accepted', async () => {
    repo.findTodayTakenMeals.mockResolvedValue({ taken: [BREAKFAST, LUNCH], groupMeals: ALL });
    await service.createRequest('u1', 'org1', {
      startDate: today,
      endDate: today,
      startSlotKey: 'dinner',
      groupId: 'g1',
    } as any);
    expect(repo.create).toHaveBeenCalled();
  });

  it('legacy org-level request (no groupId) skips the membership read', async () => {
    await service.createRequest('u1', 'org1', {
      startDate: '2098-01-01',
      endDate: '2098-01-02',
    } as any);
    expect(repo.hasActiveMembership).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ groupId: null }));
  });

  it('membership 403 wins over an overlap 422 (guard precedence)', async () => {
    repo.hasActiveMembership.mockResolvedValue(false);
    repo.findOverlapping.mockResolvedValue({ status: 'approved', startDate: new Date(), endDate: new Date() });
    await expect(
      service.createRequest('u1', 'org1', {
        startDate: '2098-01-01',
        endDate: '2098-01-02',
        groupId: 'g1',
      } as any),
    ).rejects.toThrow(ForbiddenException);
  });
});
