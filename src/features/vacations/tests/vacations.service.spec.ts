import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { VacationsService } from '../vacations.service';
import { VacationRequestsRepository } from '../repositories/vacation-requests.repository';
import { AuditService } from '../../../audit/audit.service';

/**
 * Pass 11 — vacation deep governance:
 *   FR-VACX-002 (LOOP-040) forward-only, FR-VACX-001 overlap policy,
 *   FR-VACX-006 TZ-correct activation, FR-VACX-004 (LOOP-046) keep-Present
 *   conflict surfacing.
 */
describe('VacationsService (Pass 11)', () => {
  let service: VacationsService;
  let repo: any;
  let audit: { log: jest.Mock };

  const entity = (over: Record<string, unknown> = {}) => ({
    id: 'vr1',
    organizationId: 'org1',
    groupId: null,
    userId: 'u1',
    userName: 'Member',
    startDate: new Date('2000-01-01T00:00:00.000Z'),
    endDate: new Date('2099-01-01T00:00:00.000Z'),
    startSlotKey: null,
    endSlotKey: null,
    reason: null,
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    repo = {
      getOrgTimezone: jest.fn().mockResolvedValue('Asia/Kolkata'),
      getUserName: jest.fn().mockResolvedValue('Member'),
      findOverlapping: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (d: any) => entity(d)),
      findById: jest.fn(),
      updateStatus: jest.fn().mockImplementation(async () => entity({ status: 'approved' })),
      setUserVacation: jest.fn().mockResolvedValue(undefined),
      findPresentConflicts: jest.fn().mockResolvedValue([]),
      hasApprovedCovering: jest.fn().mockResolvedValue(false),
      getUserPush: jest.fn().mockResolvedValue(null),
    };
    audit = { log: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VacationsService,
        { provide: VacationRequestsRepository, useValue: repo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(VacationsService);
  });

  it('rejects past-dated requests — vacation is forward-only (LOOP-040)', async () => {
    await expect(
      service.createRequest('u1', 'org1', {
        startDate: '2000-01-01',
        endDate: '2000-01-05',
      } as any),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects overlapping pending/approved requests (FR-VACX-001)', async () => {
    repo.findOverlapping.mockResolvedValue(entity({ status: 'approved' }));
    await expect(
      service.createRequest('u1', 'org1', {
        startDate: '2098-01-01',
        endDate: '2098-01-05',
      } as any),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('stores meal-granular slot boundaries lowercased (FR-VACX-003)', async () => {
    await service.createRequest('u1', 'org1', {
      startDate: '2098-01-01',
      endDate: '2098-01-05',
      startSlotKey: ' Dinner ',
      endSlotKey: 'LUNCH',
    } as any);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ startSlotKey: 'dinner', endSlotKey: 'lunch' }),
    );
  });

  it('approve of a FUTURE range does NOT flip the flag today (FR-VACX-006)', async () => {
    repo.findById.mockResolvedValue(
      entity({
        startDate: new Date('2099-01-01T00:00:00.000Z'),
        endDate: new Date('2099-01-05T00:00:00.000Z'),
      }),
    );
    await service.approve('admin1', 'org1', 'vr1', {} as any);
    expect(repo.setUserVacation).not.toHaveBeenCalled();
  });

  it('approve of a range covering today flips the flag ON and surfaces keep-Present conflicts (FR-VACX-004/006)', async () => {
    repo.findById.mockResolvedValue(entity());
    repo.findPresentConflicts.mockResolvedValue([
      { date: '2026-07-05', mealId: 'm1', mealName: 'Lunch' },
    ]);
    const res: any = await service.approve('admin1', 'org1', 'vr1', {} as any);
    expect(repo.setUserVacation).toHaveBeenCalledWith('u1', 'org1', true);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].mealName).toBe('Lunch');
  });

  it('cancelling an approved vacation keeps the flag when another approved range still covers today', async () => {
    repo.findById.mockResolvedValue(entity({ status: 'approved' }));
    repo.updateStatus.mockResolvedValue(entity({ status: 'cancelled' }));
    repo.hasApprovedCovering.mockResolvedValue(true);
    await service.cancel('u1', 'student', 'org1', 'vr1', {} as any);
    expect(repo.setUserVacation).not.toHaveBeenCalled();
  });

  it('non-owner non-admin cannot cancel (isolation)', async () => {
    repo.findById.mockResolvedValue(entity());
    await expect(
      service.cancel('intruder', 'student', 'org1', 'vr1', {} as any),
    ).rejects.toThrow(ForbiddenException);
  });
});
