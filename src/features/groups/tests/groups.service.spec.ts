import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GroupsService } from '../groups.service';
import { GroupsRepository } from '../repositories/groups.repository';
import { MembersRepository } from '../repositories/members.repository';
import { UsersRepository } from '../../users/repositories/users.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { GroupEntity } from '../entities/group.entity';
import { GroupMemberEntity } from '../entities/group-member.entity';

/**
 * GroupsService unit tests.
 *
 * Tests verify:
 * - Org isolation: cross-org access rejected
 * - Join code: expiry, max capacity, blocked users
 * - Membership: idempotent join, re-join, block enforcement
 * - Response shape: GroupSerializer output verified
 *
 * NOTE: No mock DB (per testing governance). These are service-level unit tests
 * with mocked repositories. Integration tests (real DB) in test/integration/.
 */
describe('GroupsService', () => {
  let service: GroupsService;
  let groupsRepo: jest.Mocked<GroupsRepository>;
  let membersRepo: jest.Mocked<MembersRepository>;
  let usersRepo: jest.Mocked<UsersRepository>;
  let auditService: jest.Mocked<AuditService>;

  const mockGroup = new GroupEntity({
    id: 'grp_01',
    organizationId: 'org_01',
    name: 'Boys Block A',
    type: 'hostel',
    description: null,
    adminId: 'usr_admin',
    joinToken: 'HTL3K8XZ',
    joinTokenExpiresAt: null,
    maxMembers: null,
    isActive: true,
    mealsEnabled: true,
    weeklyMenuEnabled: false,
    preferencesEnabled: false,
    enabledPreferences: [],
    vacationModeEnabled: true,
    memberCount: 1,
    memberIds: ['usr_admin'],
    blockedMemberIds: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  const mockActiveMember = new GroupMemberEntity({
    id: 'mem_01',
    groupId: 'grp_01',
    userId: 'usr_student',
    role: 'member',
    status: 'active',
    joinedAt: new Date(),
    updatedAt: new Date(),
    blockedAt: null,
    blockedBy: null,
    removedAt: null,
    removedBy: null,
  });

  const mockBlockedMember = new GroupMemberEntity({
    ...mockActiveMember,
    id: 'mem_02',
    userId: 'usr_blocked',
    status: 'blocked',
    blockedAt: new Date(),
    blockedBy: 'usr_admin',
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupsService,
        {
          provide: GroupsRepository,
          useValue: {
            findById: jest.fn(),
            findAll: jest.fn(),
            findByMembership: jest.fn(),
            findByJoinCode: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            softDelete: jest.fn(),
            regenerateJoinCode: jest.fn(),
            // ISSUE 2: detail-view admin/org name resolver.
            getDetailNames: jest
              .fn()
              .mockResolvedValue({ adminName: null, organizationName: null }),
          },
        },
        {
          provide: MembersRepository,
          useValue: {
            findByGroupId: jest.fn(),
            findMembership: jest.fn(),
            findMembershipsForUserInGroups: jest.fn().mockResolvedValue(new Map()),
            createMembership: jest.fn(),
            updateMembership: jest.fn(),
            isActiveMember: jest.fn(),
            countActiveMembers: jest.fn(),
          },
        },
        {
          provide: UsersRepository,
          useValue: {
            findById: jest.fn().mockResolvedValue({ id: 'usr_student', organizationId: null }),
            update: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: AuditService,
          useValue: { log: jest.fn() },
        },
        {
          // Module 02: groups.* config namespace — mock returns undefined so the
          // service falls back to its documented defaults.
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<GroupsService>(GroupsService);
    groupsRepo = module.get(GroupsRepository);
    membersRepo = module.get(MembersRepository);
    usersRepo = module.get(UsersRepository);
    auditService = module.get(AuditService);
  });

  // ── GET GROUP BY ID — ORG ISOLATION ──────────────────────────────────────

  describe('getGroupById', () => {
    it('throws NotFoundException for group in different org (isolation check)', async () => {
      // Repository returns null when org doesn't match (query includes organizationId)
      groupsRepo.findById.mockResolvedValue(null);

      await expect(
        service.getGroupById('grp_01', 'org_ATTACKER', 'usr_attacker', 'hostelAdmin'),
      ).rejects.toThrow(NotFoundException);

      // Verify repository was called with the org from JWT (not the attacker's org).
      // Module 02 (GRP-018/019): admins pass includeInactive=true so they can
      // open archived groups to restore / permanently delete them.
      expect(groupsRepo.findById).toHaveBeenCalledWith('grp_01', 'org_ATTACKER', true);
    });

    it('returns group for admin without membership check', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);

      const result = await service.getGroupById('grp_01', 'org_01', 'usr_admin', 'hostelAdmin');

      expect(result).toHaveProperty('id', 'grp_01');
      expect(result).toHaveProperty('joinCode', 'HTL3K8XZ'); // M-06 contract
      expect(result).not.toHaveProperty('joinToken');         // internal key must not leak
      expect(result.mealConfig).toBeDefined();                // M-07 contract
    });

    it('returns 403 for student who is not a group member', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      membersRepo.isActiveMember.mockResolvedValue(false);

      await expect(
        service.getGroupById('grp_01', 'org_01', 'usr_outsider', 'student'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── JOIN GROUP — BUSINESS RULES ───────────────────────────────────────────

  describe('joinGroup', () => {
    it('throws BadRequestException for invalid join code', async () => {
      groupsRepo.findByJoinCode.mockResolvedValue(null);

      await expect(
        service.joinGroup('usr_student', { joinCode: 'INVALID1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for expired join code', async () => {
      const expiredGroup = new GroupEntity({
        ...mockGroup,
        joinTokenExpiresAt: new Date('2020-01-01'), // past date
      });
      groupsRepo.findByJoinCode.mockResolvedValue(expiredGroup);
      membersRepo.findMembership.mockResolvedValue(null);

      await expect(
        service.joinGroup('usr_student', { joinCode: 'HTL3K8XZ' }),
      ).rejects.toThrow(BadRequestException);
    });

    // Pass 10 — SRS FR-GRP-015/FR-JOIN-012 (SC-043): 409 GROUP_FULL.
    it('rejects joining a full group with 409 GROUP_FULL', async () => {
      const fullGroup = new GroupEntity({ ...mockGroup, maxMembers: 1, memberCount: 1 });
      groupsRepo.findByJoinCode.mockResolvedValue(fullGroup);
      membersRepo.findMembership.mockResolvedValue(null);

      await expect(
        service.joinGroup('usr_new', { joinCode: 'HTL3K8XZ' }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'GROUP_FULL' }),
      });
    });

    it('throws ForbiddenException for blocked user', async () => {
      groupsRepo.findByJoinCode.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(mockBlockedMember);

      await expect(
        service.joinGroup('usr_blocked', { joinCode: 'HTL3K8XZ' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('is idempotent for already-active member', async () => {
      groupsRepo.findByJoinCode.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(mockActiveMember);

      const result = await service.joinGroup('usr_student', { joinCode: 'HTL3K8XZ' });

      // Should succeed without creating duplicate
      expect(membersRepo.createMembership).not.toHaveBeenCalled();
      expect(result).toHaveProperty('joinCode');
    });

    it('creates membership for new user', async () => {
      groupsRepo.findByJoinCode.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(null);
      membersRepo.createMembership.mockResolvedValue(mockActiveMember);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      usersRepo.findById.mockResolvedValue({ id: 'usr_new', organizationId: null } as any);

      await service.joinGroup('usr_new', { joinCode: 'HTL3K8XZ' });

      expect(membersRepo.createMembership).toHaveBeenCalledWith({
        groupId: 'grp_01',
        userId: 'usr_new',
        // Module 02 (MEM-004): status is now explicit — immediate-join groups
        // (joinApprovalRequired falsey) create an ACTIVE membership.
        status: 'active',
        // #2: additive per-group display role — null when the join omits it.
        functionalRole: null,
      });
      // Should sync organizationId for user without org
      expect(usersRepo.update).toHaveBeenCalledWith('usr_new', { organizationId: 'org_01' });
    });

    it('re-activates removed member on rejoin', async () => {
      const removedMember = new GroupMemberEntity({
        ...mockActiveMember,
        status: 'removed',
        removedAt: new Date('2025-01-01'),
        removedBy: 'usr_admin',
      });
      groupsRepo.findByJoinCode.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(removedMember);
      membersRepo.updateMembership.mockResolvedValue({ ...removedMember, status: 'active' } as any);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      usersRepo.findById.mockResolvedValue({ id: 'usr_student', organizationId: 'org_01' } as any);

      await service.joinGroup('usr_student', { joinCode: 'HTL3K8XZ' });

      expect(membersRepo.updateMembership).toHaveBeenCalledWith(
        'grp_01',
        'usr_student',
        expect.objectContaining({ status: 'active' }),
      );
      expect(membersRepo.createMembership).not.toHaveBeenCalled();
    });

    // UNI-015 reuses the SAME membership row on rejoin, so anything left on it
    // survives the removal. For the per-group settings that is a financial
    // trap of the same class as the stale blockedAt (BR-24): a member who was
    // on vacation — or auto-marking — in this group before being removed would
    // silently resume both months later, suppressing or creating charges they
    // never asked for. They must come back inheriting, i.e. NULL — not false,
    // which would instead pin them OFF against a later org-wide vacation.
    it('rejoin CLEARS the per-group vacation / auto-attendance settings', async () => {
      const removedMember = new GroupMemberEntity({
        ...mockActiveMember,
        status: 'removed',
        removedAt: new Date('2025-01-01'),
        removedBy: 'usr_admin',
        isVacationMode: true,
        isDefaultAttendance: true,
      });
      groupsRepo.findByJoinCode.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(removedMember);
      membersRepo.updateMembership.mockResolvedValue({
        ...removedMember,
        status: 'active',
      } as any);
      groupsRepo.findById.mockResolvedValue(mockGroup);
      usersRepo.findById.mockResolvedValue({
        id: 'usr_student',
        organizationId: 'org_01',
      } as any);

      await service.joinGroup('usr_student', { joinCode: 'HTL3K8XZ' });

      const patch = membersRepo.updateMembership.mock.calls[0][2];
      expect(patch.isVacationMode).toBeNull();
      expect(patch.isDefaultAttendance).toBeNull();
      // Same reset the pre-existing BR-24 guard makes for the block trail.
      expect(patch.blockedAt).toBeNull();
    });
  });

  // ── JOIN APPROVAL WORKFLOW (Module 02, MEM-004..007) ──────────────────────

  describe('join approval workflow', () => {
    const approvalGroup = new GroupEntity({
      ...mockGroup,
      joinApprovalRequired: true,
    });

    it('creates a PENDING membership and returns joinStatus=pending', async () => {
      groupsRepo.findByJoinCode.mockResolvedValue(approvalGroup);
      membersRepo.findMembership.mockResolvedValue(null);
      membersRepo.createMembership.mockResolvedValue(mockActiveMember);
      usersRepo.findById.mockResolvedValue({ id: 'usr_new', name: 'New User' } as any);

      const result = await service.joinGroup('usr_new', { joinCode: 'HTL3K8XZ' });

      expect(membersRepo.createMembership).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' }),
      );
      // No org sync until approved.
      expect(usersRepo.update).not.toHaveBeenCalled();
      expect(result).toHaveProperty('joinStatus', 'pending');
    });

    it('counts pending toward capacity (GROUP_FULL when active+pending = max)', async () => {
      const nearFull = new GroupEntity({
        ...approvalGroup,
        maxMembers: 2,
        memberCount: 1,
        pendingCount: 1,
      });
      groupsRepo.findByJoinCode.mockResolvedValue(nearFull);
      membersRepo.findMembership.mockResolvedValue(null);

      await expect(
        service.joinGroup('usr_new', { joinCode: 'HTL3K8XZ' }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'GROUP_FULL' }),
      });
    });

    it('approveJoinRequest activates a pending member', async () => {
      groupsRepo.findById.mockResolvedValue(approvalGroup);
      membersRepo.findMembership.mockResolvedValue(
        new GroupMemberEntity({ ...mockActiveMember, status: 'pending' }),
      );
      membersRepo.updateMembership.mockResolvedValue(mockActiveMember as any);
      usersRepo.findById.mockResolvedValue({ id: 'usr_student', organizationId: null } as any);

      await service.approveJoinRequest('grp_01', 'usr_student', 'org_01', 'usr_admin');

      expect(membersRepo.updateMembership).toHaveBeenCalledWith(
        'grp_01',
        'usr_student',
        expect.objectContaining({ status: 'active', reviewedBy: 'usr_admin' }),
      );
    });

    it('rejectJoinRequest removes the pending row', async () => {
      groupsRepo.findById.mockResolvedValue(approvalGroup);
      membersRepo.findMembership.mockResolvedValue(
        new GroupMemberEntity({ ...mockActiveMember, status: 'pending' }),
      );
      (membersRepo as any).hardDelete = jest.fn().mockResolvedValue(undefined);

      const res = await service.rejectJoinRequest(
        'grp_01',
        'usr_student',
        'org_01',
        'usr_admin',
        'No capacity',
      );

      expect((membersRepo as any).hardDelete).toHaveBeenCalledWith('grp_01', 'usr_student');
      expect(res).toMatchObject({ success: true });
    });

    it('approveJoinRequest 404s when there is no pending request', async () => {
      groupsRepo.findById.mockResolvedValue(approvalGroup);
      membersRepo.findMembership.mockResolvedValue(mockActiveMember); // already active

      await expect(
        service.approveJoinRequest('grp_01', 'usr_student', 'org_01', 'usr_admin'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── SERIALIZER CONTRACT IN SERVICE OUTPUT ────────────────────────────────

  describe('getGroups serializer output', () => {
    it('returns correct pagination shape: { data, total, page, limit }', async () => {
      groupsRepo.findAll.mockResolvedValue({
        data: [mockGroup],
        total: 1,
        page: 1,
        limit: 20,
      });

      const result = await service.getGroups('usr_admin', 'hostelAdmin', 'org_01', {
        page: 1,
        limit: 20,
      });

      // CRITICAL: Flutter reads these exact keys
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 20);

      // Verify serializer applied: joinCode not joinToken, mealConfig nested
      const group = result.data[0];
      expect(group).toHaveProperty('joinCode');
      expect(group).not.toHaveProperty('joinToken');
      expect(group).toHaveProperty('mealConfig');
    });

    it('never returns "items", "results", "count", "pageSize" keys', async () => {
      groupsRepo.findAll.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });

      const result = await service.getGroups('usr_admin', 'hostelAdmin', 'org_01', {});

      expect(result).not.toHaveProperty('items');
      expect(result).not.toHaveProperty('results');
      expect(result).not.toHaveProperty('count');
      expect(result).not.toHaveProperty('pageSize');
    });
  });

  // ── MEMBER MANAGEMENT — BLOCK/REMOVE ────────────────────────────────────

  describe('updateMember', () => {
    it('throws NotFoundException if member not in group', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(null);

      await expect(
        service.updateMember('grp_01', 'usr_unknown', 'org_01', 'usr_admin', { status: 'blocked' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('prevents admin from blocking themselves', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(mockActiveMember);

      await expect(
        service.updateMember('grp_01', 'usr_admin', 'org_01', 'usr_admin', { status: 'blocked' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sets blockedAt and blockedBy when blocking', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      membersRepo.findMembership.mockResolvedValue(mockActiveMember);
      membersRepo.updateMembership.mockResolvedValue({
        ...mockActiveMember,
        status: 'blocked',
        blockedAt: new Date(),
        blockedBy: 'usr_admin',
      } as any);

      await service.updateMember(
        'grp_01', 'usr_student', 'org_01', 'usr_admin',
        { status: 'blocked' },
      );

      expect(membersRepo.updateMembership).toHaveBeenCalledWith(
        'grp_01',
        'usr_student',
        expect.objectContaining({
          status: 'blocked',
          blockedAt: expect.any(Date),
          blockedBy: 'usr_admin',
        }),
      );
    });
  });

  // ── GUEST-CONFIG VALIDATION (FR-HG-021 — golden fix) ─────────────────────
  // An explicit null means "CLEAR this field": it must be validated as the
  // true final state (the old `??` fallback let a cleared price slip past
  // while the pricing mode still required it), and null must never be
  // written to a NOT-NULL boolean column.

  describe('updateGroup guest-config validation (FR-HG-021)', () => {
    const guestGroup = new GroupEntity({
      ...mockGroup,
      guestAttendanceEnabled: true,
      guestPricingMode: 'perGuestPrice',
      guestAdultPrice: 80,
      guestSurcharge: 20,
    } as any);

    it('rejects CLEARING guestAdultPrice while mode stays perGuestPrice (422 GUEST_PRICE_REQUIRED)', async () => {
      groupsRepo.findById.mockResolvedValue(guestGroup);

      await expect(
        service.updateGroup('grp_01', 'org_01', 'usr_admin', {
          mealConfig: { guestConfig: { guestAdultPrice: null } },
        } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GUEST_PRICE_REQUIRED' }),
      });
      expect(groupsRepo.update).not.toHaveBeenCalled();
    });

    it('rejects clearing guestSurcharge while mode is flatSurcharge (422 GUEST_SURCHARGE_REQUIRED)', async () => {
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({ ...guestGroup, guestPricingMode: 'flatSurcharge' } as any),
      );

      await expect(
        service.updateGroup('grp_01', 'org_01', 'usr_admin', {
          mealConfig: { guestConfig: { guestSurcharge: null } },
        } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GUEST_SURCHARGE_REQUIRED' }),
      });
    });

    it('allows clearing a price when the SAME patch switches the mode away; null on a NOT-NULL boolean is ignored', async () => {
      groupsRepo.findById.mockResolvedValue(guestGroup);
      groupsRepo.update.mockResolvedValue(guestGroup);

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: {
          guestConfig: {
            guestPricingMode: 'sameAsMember',
            guestAdultPrice: null,
            guestRequiresApproval: null, // NOT NULL column — must be skipped
          },
        },
      } as any);

      expect(groupsRepo.update).toHaveBeenCalledWith(
        'grp_01',
        'org_01',
        expect.objectContaining({
          guestPricingMode: 'sameAsMember',
          guestAdultPrice: null, // legitimate clear persists
        }),
      );
      const written = (groupsRepo.update as jest.Mock).mock.calls[0][2];
      expect('guestRequiresApproval' in written).toBe(false);
    });
  });

  // ── LT17-BC — billing cycle: DRAFT-unlimited → first publish → LOCKED ─────
  //
  // Supersedes the former one-time `billingCycleChangedAt` privilege (RET-053).
  // The mandatory First-Publish financial review is now the single decision
  // gate, so a second post-publish change opportunity no longer exists.

  describe('billing-cycle start day: draft-unlimited, locked at first publish', () => {
    const draftGroup = (day: number | null) =>
      new GroupEntity({
        ...mockGroup,
        mealsEnabled: true,
        mealPricingEnabled: true,
        billingCycleStartDay: day,
        firstSchedulePublishedAt: null,
      } as any);

    it('LT17-BC-01: a DRAFT group may change the cycle freely (no privilege consumed)', async () => {
      groupsRepo.findById.mockResolvedValue(draftGroup(1));
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: 15 },
      } as any);

      const data = groupsRepo.update.mock.calls[0][2];
      expect(data.billingCycleStartDay).toBe(15);
      // The one-time marker must NO LONGER be written — writing it would
      // silently re-lock the draft phase on the very next change.
      expect(data.billingCycleChangedAt).toBeUndefined();
    });

    it('LT17-BC-02: a SECOND draft change is still allowed (unlimited while draft)', async () => {
      // Simulates the group AFTER BC-01: cycle already moved once, never
      // published. Under the old rule this was a hard 400.
      groupsRepo.findById.mockResolvedValue(draftGroup(15));
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: 8 },
      } as any);

      expect(groupsRepo.update.mock.calls[0][2].billingCycleStartDay).toBe(8);
    });

    it('LT17-BC-03: a legacy group that consumed the OLD privilege is draft again', async () => {
      // `billingCycleChangedAt` is retained for API/DB compatibility but must
      // no longer gate anything, or client and server would disagree.
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({
          ...mockGroup,
          mealsEnabled: true,
          mealPricingEnabled: true,
          billingCycleStartDay: 15,
          billingCycleChangedAt: new Date('2026-07-01T00:00:00.000Z'),
          firstSchedulePublishedAt: null,
        } as any),
      );
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: 10 },
      } as any);

      expect(groupsRepo.update.mock.calls[0][2].billingCycleStartDay).toBe(10);
    });

    it('LT17-BC-04: after the FIRST publish the cycle is permanently locked', async () => {
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({
          ...mockGroup,
          mealsEnabled: true,
          mealPricingEnabled: true,
          billingCycleStartDay: 15,
          firstSchedulePublishedAt: new Date('2026-08-01T00:00:00.000Z'),
        } as any),
      );

      await expect(
        service.updateGroup('grp_01', 'org_01', 'usr_admin', {
          mealConfig: { billingCycleStartDay: 10 },
        } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'BILLING_CYCLE_LOCKED' }),
      });
      expect(groupsRepo.update).not.toHaveBeenCalled();
    });

    it('LT17-BC-05: a NO-OP echo on a LOCKED group still succeeds', async () => {
      // THE critical regression guard: Flutter PATCHes the WHOLE mealConfig on
      // every unrelated toggle. If the lock were presence-based instead of
      // comparison-based, every vacation/guest/meals edit on a published group
      // would 400.
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({
          ...mockGroup,
          mealsEnabled: true,
          mealPricingEnabled: true,
          billingCycleStartDay: 15,
          firstSchedulePublishedAt: new Date('2026-08-01T00:00:00.000Z'),
        } as any),
      );
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: 15, vacationModeEnabled: false },
      } as any);

      const data = groupsRepo.update.mock.calls[0][2];
      expect(data.billingCycleStartDay).toBeUndefined();
      expect(data.vacationModeEnabled).toBe(false);
    });

    it('LT17-BC-06: an Attendance-Only group has NO billing cycle', async () => {
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({
          ...mockGroup,
          mealsEnabled: false,
          billingCycleStartDay: null,
          firstSchedulePublishedAt: null,
        } as any),
      );

      await expect(
        service.updateGroup('grp_01', 'org_01', 'usr_admin', {
          mealConfig: { billingCycleStartDay: 10 },
        } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BILLING_CYCLE_NOT_APPLICABLE',
        }),
      });
      expect(groupsRepo.update).not.toHaveBeenCalled();
    });

    it('LT17-BC-07: the AO gate reads the EFFECTIVE mode, not the stored one', async () => {
      // meals ON in the DB, turned OFF in this same patch → the group ends up
      // Attendance-Only, so the cycle change must be rejected.
      groupsRepo.findById.mockResolvedValue(draftGroup(1));

      await expect(
        service.updateGroup('grp_01', 'org_01', 'usr_admin', {
          mealConfig: { mealsEnabled: false, billingCycleStartDay: 10 },
        } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BILLING_CYCLE_NOT_APPLICABLE',
        }),
      });
    });

    it('BOUNDARY: cycle day 1 and 28 are both accepted while draft', async () => {
      for (const day of [1, 28]) {
        groupsRepo.update.mockClear();
        groupsRepo.findById.mockResolvedValue(draftGroup(15));
        groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));
        await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
          mealConfig: { billingCycleStartDay: day },
        } as any);
        expect(groupsRepo.update.mock.calls[0][2].billingCycleStartDay).toBe(day);
      }
    });

    it('BOUNDARY: null (calendar month) -> a day, and back to null, both work while draft', async () => {
      // null is a REAL configured value (calendar month), not "unset".
      groupsRepo.findById.mockResolvedValue(draftGroup(null));
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));
      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: 15 },
      } as any);
      expect(groupsRepo.update.mock.calls[0][2].billingCycleStartDay).toBe(15);
    });

    it('CORNER: null -> null is a NO-OP even on a locked group', async () => {
      // Both sides normalise through `?? null`, so an undefined/null echo from a
      // calendar-month group must not read as a change.
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({
          ...mockGroup,
          mealsEnabled: true,
          mealPricingEnabled: true,
          billingCycleStartDay: null,
          firstSchedulePublishedAt: new Date('2026-08-01T00:00:00.000Z'),
        } as any),
      );
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: null },
      } as any);

      expect(groupsRepo.update).toHaveBeenCalled();
      expect(groupsRepo.update.mock.calls[0][2].billingCycleStartDay).toBeUndefined();
    });

    it('CORNER: ON -> publish -> OFF -> ON keeps the cycle LOCKED (no draft reset)', async () => {
      // The toggle-abuse bypass. `firstSchedulePublishedAt` is monotonic, so a
      // meals OFF/ON round trip must never mint a second draft phase.
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({
          ...mockGroup,
          mealsEnabled: true, // toggled back ON after the publish
          mealPricingEnabled: true,
          billingCycleStartDay: 15,
          firstSchedulePublishedAt: new Date('2026-08-01T00:00:00.000Z'),
        } as any),
      );

      await expect(
        service.updateGroup('grp_01', 'org_01', 'usr_admin', {
          mealConfig: { mealsEnabled: true, billingCycleStartDay: 9 },
        } as any),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'BILLING_CYCLE_LOCKED' }),
      });
    });

    it('MULTI-TENANT: the org from the JWT is what reaches the repository', async () => {
      groupsRepo.findById.mockResolvedValue(draftGroup(1));
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: 15 },
      } as any);

      expect(groupsRepo.findById).toHaveBeenCalledWith('grp_01', 'org_01');
      expect(groupsRepo.update.mock.calls[0][1]).toBe('org_01');
    });

    it('LT17-BC-08: a NO-OP echo from an AO group is never rejected', async () => {
      // A legacy AO group that still stores a cycle day keeps re-sending it on
      // every unrelated toggle — that must not 400.
      groupsRepo.findById.mockResolvedValue(
        new GroupEntity({
          ...mockGroup,
          mealsEnabled: false,
          billingCycleStartDay: 12,
          firstSchedulePublishedAt: null,
        } as any),
      );
      groupsRepo.update.mockResolvedValue(new GroupEntity({ ...mockGroup } as any));

      await service.updateGroup('grp_01', 'org_01', 'usr_admin', {
        mealConfig: { billingCycleStartDay: 12, vacationModeEnabled: true },
      } as any);

      expect(groupsRepo.update).toHaveBeenCalled();
      expect(groupsRepo.update.mock.calls[0][2].billingCycleStartDay).toBeUndefined();
    });
  });

  describe('deleteGroup (soft)', () => {
    it('soft-deletes group without destroying member records', async () => {
      groupsRepo.findById.mockResolvedValue(mockGroup);
      groupsRepo.softDelete.mockResolvedValue(undefined);

      const result = await service.deleteGroup('grp_01', 'org_01', 'usr_admin');

      expect(groupsRepo.softDelete).toHaveBeenCalledWith('grp_01', 'org_01');
      expect(result).toHaveProperty('message', 'Group archived successfully');
      // Hard delete must never be called
    });
  });
});
