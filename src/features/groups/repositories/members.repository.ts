import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { GroupMemberEntity } from '../entities/group-member.entity';

/**
 * MembersRepository — GroupMember table queries.
 *
 * Governance:
 * - Organization isolation enforced via relation filter: group.organizationId
 * - Soft removal pattern: status='removed' (never hard delete unless user requests account deletion)
 * - Pagination: always returns { data, total, page, limit }
 */
@Injectable()
export class MembersRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any): GroupMemberEntity {
    return new GroupMemberEntity(raw);
  }

  /**
   * Paginated member list — org-isolated via group relation filter.
   */
  async findByGroupId(
    groupId: string,
    organizationId: string,
    opts: { page: number; limit: number; status?: string },
  ): Promise<{ data: GroupMemberEntity[]; total: number; page: number; limit: number }> {
    const where = {
      groupId,
      group: { organizationId }, // org isolation through relation
      ...(opts.status ? { status: opts.status as any } : {}),
    };
    const skip = (opts.page - 1) * opts.limit;

    const [members, total] = await Promise.all([
      this.prisma.groupMember.findMany({
        where,
        skip,
        take: opts.limit,
        orderBy: { joinedAt: 'asc' },
        // B10 (additive): join user profile so the Flutter member directory
        // can render names/contacts without N+1 /users/:id calls.
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              avatarUrl: true,
              gender: true,
              age: true,
              role: true,
              isVacationMode: true,
              emailVerifiedAt: true, // SRS AUTH-036/040 — drives member verified badge
            },
          },
        },
      }),
      this.prisma.groupMember.count({ where }),
    ]);

    return {
      data: members.map((m) => this.toEntity(m)),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  }

  /**
   * Find a single membership record. Null = not a member.
   */
  async findMembership(groupId: string, userId: string): Promise<GroupMemberEntity | null> {
    const m = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    return m ? this.toEntity(m) : null;
  }

  /**
   * Batch variant of {@link findMembership}: fetch this user's memberships
   * across many groups in ONE query, returned as a Map keyed by groupId.
   *
   * Eliminates the per-group N+1 in the group-list endpoint (was one
   * findMembership() per returned group). Groups where the user is not a member
   * simply have no entry. Org isolation is already guaranteed upstream because
   * the caller only passes groupIds it fetched within the user's organization.
   */
  async findMembershipsForUserInGroups(
    userId: string,
    groupIds: string[],
  ): Promise<Map<string, GroupMemberEntity>> {
    if (groupIds.length === 0) return new Map();
    const rows = await this.prisma.groupMember.findMany({
      where: { userId, groupId: { in: groupIds } },
    });
    const byGroupId = new Map<string, GroupMemberEntity>();
    for (const r of rows) {
      byGroupId.set(r.groupId, this.toEntity(r));
    }
    return byGroupId;
  }

  /**
   * Create membership. Returns the created record.
   */
  async createMembership(data: {
    groupId: string;
    userId: string;
    role?: string;
    status?: string;
    functionalRole?: string | null; // additive (#8): per-group functional title
  }): Promise<GroupMemberEntity> {
    const m = await this.prisma.groupMember.create({
      data: {
        groupId: data.groupId,
        userId: data.userId,
        role: (data.role ?? 'member') as any,
        status: (data.status ?? 'active') as any,
        ...(data.functionalRole !== undefined
          ? { functionalRole: data.functionalRole as any }
          : {}),
      },
    });
    return this.toEntity(m);
  }

  /**
   * Update membership status/role with audit fields.
   */
  async updateMembership(
    groupId: string,
    userId: string,
    data: Partial<{
      role: string;
      functionalRole: string | null; // additive (#8)
      status: string;
      blockedAt: Date | null;
      blockedBy: string | null;
      removedAt: Date | null;
      removedBy: string | null;
      // Module 02 (MEM-004/006/007): join-approval decision trail.
      reviewedBy: string | null;
      reviewedAt: Date | null;
      reviewNote: string | null;
    }>,
  ): Promise<GroupMemberEntity> {
    const m = await this.prisma.groupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data: data as any,
    });
    return this.toEntity(m);
  }

  /**
   * Hard delete — only used when user requests full account deletion.
   * Normal removal uses status='removed' (soft).
   */
  async hardDelete(groupId: string, userId: string): Promise<void> {
    await this.prisma.groupMember.delete({
      where: { groupId_userId: { groupId, userId } },
    });
  }

  async countActiveMembers(groupId: string): Promise<number> {
    return this.prisma.groupMember.count({
      where: { groupId, status: 'active' },
    });
  }

  /**
   * Check if user is an active member of the group (for permission checks).
   */
  async isActiveMember(groupId: string, userId: string): Promise<boolean> {
    const count = await this.prisma.groupMember.count({
      where: { groupId, userId, status: 'active' },
    });
    return count > 0;
  }
}
