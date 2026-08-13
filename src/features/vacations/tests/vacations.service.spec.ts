import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { VacationsService } from '../vacations.service';
import { VacationRequestsRepository } from '../repositories/vacation-requests.repository';
import { AuditService } from '../../../audit/audit.service';
import { NoticesService } from '../../notices/notices.service';

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
    // ORG-LEVEL request (groupId null) → still writes the ACCOUNT flag,
    // byte-identical to the behaviour before group scoping.
    expect(repo.setUserVacation).toHaveBeenCalledWith('u1', 'org1', true, null);
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

  // ── Live-Test-15 ISSUE-2B — ended vacation is immutable (USER-LOCKED) ──────

  it('ISSUE-2B: an APPROVED vacation whose endDate has passed cannot be cancelled by the OWNER', async () => {
    repo.findById.mockResolvedValue(
      entity({
        status: 'approved',
        startDate: new Date('2000-01-01T00:00:00.000Z'),
        endDate: new Date('2000-01-05T00:00:00.000Z'),
      }),
    );
    await expect(
      service.cancel('u1', 'student', 'org1', 'vr1', {} as any),
    ).rejects.toThrow(BadRequestException);
    expect(repo.updateStatus).not.toHaveBeenCalled();
  });

  it('ISSUE-2B: an ADMIN cannot cancel an ended vacation either — no role may', async () => {
    repo.findById.mockResolvedValue(
      entity({
        status: 'approved',
        startDate: new Date('2000-01-01T00:00:00.000Z'),
        endDate: new Date('2000-01-05T00:00:00.000Z'),
      }),
    );
    await expect(
      service.cancel('admin1', 'hostelAdmin', 'org1', 'vr1', {} as any),
    ).rejects.toThrow(BadRequestException);
    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(repo.setUserVacation).not.toHaveBeenCalled();
  });

  it('ISSUE-2B: a still-running approved vacation REMAINS cancellable', async () => {
    repo.findById.mockResolvedValue(
      entity({ status: 'approved', endDate: new Date('2099-01-01T00:00:00.000Z') }),
    );
    await service.cancel('u1', 'student', 'org1', 'vr1', {} as any);
    expect(repo.updateStatus).toHaveBeenCalled();
  });

  it('ISSUE-2B: an expired PENDING request stays cancellable (never took effect; overlap counts pending)', async () => {
    repo.findById.mockResolvedValue(
      entity({
        status: 'pending',
        startDate: new Date('2000-01-01T00:00:00.000Z'),
        endDate: new Date('2000-01-05T00:00:00.000Z'),
      }),
    );
    await service.cancel('u1', 'student', 'org1', 'vr1', {} as any);
    expect(repo.updateStatus).toHaveBeenCalled();
  });
});

// ── Live-Test-15 ISSUE-2A — cancellation notifies the member ─────────────────

describe('VacationsService — cancel notifications (ISSUE-2A)', () => {
  let service: VacationsService;
  let repo: any;
  let notices: { createMemberAlert: jest.Mock; createRequestAlert: jest.Mock };

  const approved = (over: Record<string, unknown> = {}) => ({
    id: 'vr1',
    organizationId: 'org1',
    groupId: null,
    userId: 'u1',
    userName: 'Member',
    startDate: new Date('2098-01-01T00:00:00.000Z'),
    endDate: new Date('2099-01-01T00:00:00.000Z'),
    startSlotKey: null,
    endSlotKey: null,
    reason: null,
    status: 'approved',
    reviewedBy: 'admin1',
    reviewedAt: new Date(),
    reviewNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    repo = {
      getOrgTimezone: jest.fn().mockResolvedValue('Asia/Kolkata'),
      findById: jest.fn().mockResolvedValue(approved()),
      updateStatus: jest.fn().mockImplementation(async () => approved({ status: 'cancelled' })),
      setUserVacation: jest.fn().mockResolvedValue(undefined),
      hasApprovedCovering: jest.fn().mockResolvedValue(false),
      getUserPush: jest.fn().mockResolvedValue(null),
    };
    notices = {
      createMemberAlert: jest.fn().mockResolvedValue(undefined),
      createRequestAlert: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VacationsService,
        { provide: VacationRequestsRepository, useValue: repo },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NoticesService, useValue: notices },
      ],
    }).compile();
    service = module.get(VacationsService);
  });

  it('an ADMIN cancelling a member vacation alerts the MEMBER (was silent)', async () => {
    await service.cancel('admin1', 'hostelAdmin', 'org1', 'vr1', {} as any);
    expect(notices.createMemberAlert).toHaveBeenCalledTimes(1);
    const arg = notices.createMemberAlert.mock.calls[0][0];
    expect(arg.targetUserId).toBe('u1');
    expect(arg.title).toBe('Vacation cancelled');
    expect(arg.linkType).toBe('myVacations');
  });

  it('a SELF-cancel does not alert the person who performed it', async () => {
    await service.cancel('u1', 'student', 'org1', 'vr1', {} as any);
    expect(notices.createMemberAlert).not.toHaveBeenCalled();
  });
});
