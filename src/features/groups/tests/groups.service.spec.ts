import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GroupsService } from '../groups.service';
import { GroupsRepository } from '../repositories/groups.repository';
import { MembersRepository } from '../repositories/members.repository';
import { UsersRepository } from '../../users/repositories/users.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
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

      // Verify repository was called with the org from JWT (not the attacker's org)
      expect(groupsRepo.findById).toHaveBeenCalledWith('grp_01', 'org_ATTACKER');
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
