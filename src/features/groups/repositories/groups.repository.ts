import { Injectable, NotFoundException } from '@nestjs/common';
import { MemberStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { GroupEntity } from '../entities/group.entity';

/**
 * GroupsRepository — all DB queries for Group model.
 *
 * Governance rules:
 * - Every query MUST include organizationId in WHERE (tenant isolation).
 * - organizationId always comes from JWT — never from client payload.
 * - Computed fields (memberCount, memberIds, blockedMemberIds) resolved here
 *   via relation include — not in the service.
 * - Soft-delete: isActive=false. Hard delete never used.
 */
@Injectable()
export class GroupsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Entity builder — computes membership fields from included relation ─────

  private buildEntity(raw: any): GroupEntity {
    const members: Array<{ userId: string; status: string }> = raw.members ?? [];
    const activeMembers = members.filter((m) => m.status === 'active');
    const blockedMembers = members.filter((m) => m.status === 'blocked');

    return new GroupEntity({
      ...raw,
      memberCount: activeMembers.length,
      memberIds: activeMembers.map((m) => m.userId),
      blockedMemberIds: blockedMembers.map((m) => m.userId),
    });
  }

  // Members select clause — reused across queries for consistency
  private get memberSelect() {
    return { select: { userId: true, status: true } };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async findById(
    id: string,
    organizationId: string,
    includeInactive = false,
  ): Promise<GroupEntity | null> {
    const group = await this.prisma.group.findFirst({
      where: {
        id,
        organizationId, // CRITICAL: tenant isolation
        ...(includeInactive ? {} : { isActive: true }),
      },
      include: { members: this.memberSelect },
    });
    return group ? this.buildEntity(group) : null;
  }

  async findAll(
    organizationId: string,
    opts: {
      page: number;
      limit: number;
      type?: string;
      includeInactive?: boolean;
    },
  ): Promise<{ data: GroupEntity[]; total: number; page: number; limit: number }> {
    const where = {
      organizationId, // CRITICAL: tenant isolation
      ...(opts.includeInactive ? {} : { isActive: true }),
      ...(opts.type ? { type: opts.type as any } : {}),
    };
    const skip = (opts.page - 1) * opts.limit;

    const [groups, total] = await Promise.all([
      this.prisma.group.findMany({
        where,
        skip,
        take: opts.limit,
        orderBy: { createdAt: 'desc' },
        include: { members: this.memberSelect },
      }),
      this.prisma.group.count({ where }),
    ]);

    return {
      data: groups.map((g) => this.buildEntity(g)),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  }

  /**
   * Find groups the user is an active member of (for student role filter).
   */
  async findByMembership(
    userId: string,
    organizationId: string,
    opts: { page: number; limit: number },
  ): Promise<{ data: GroupEntity[]; total: number; page: number; limit: number }> {
    const where = {
      organizationId,
      isActive: true,
      members: {
        some: { userId, status: MemberStatus.active },
      },
    };
    const skip = (opts.page - 1) * opts.limit;

    const [groups, total] = await Promise.all([
      this.prisma.group.findMany({
        where,
        skip,
        take: opts.limit,
        orderBy: { createdAt: 'desc' },
        include: { members: this.memberSelect },
      }),
      this.prisma.group.count({ where }),
    ]);

    return {
      data: groups.map((g) => this.buildEntity(g)),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  }

  /**
   * Find group by joinToken (= joinCode in API).
   * Does NOT enforce organizationId — the joinToken is globally unique.
   * Caller must verify org isolation after join.
   */
  async findByJoinCode(joinToken: string): Promise<GroupEntity | null> {
    const group = await this.prisma.group.findUnique({
      where: { joinToken },
      include: { members: this.memberSelect },
    });
    return group ? this.buildEntity(group) : null;
  }

  async create(data: {
    organizationId: string;
    name: string;
    type: string;
    description?: string;
    adminId?: string;
    joinToken: string;
    maxMembers?: number;
    mealsEnabled?: boolean;
    weeklyMenuEnabled?: boolean;
    preferencesEnabled?: boolean;
    enabledPreferences?: string[];
    vacationModeEnabled?: boolean;
  }): Promise<GroupEntity> {
    const group = await this.prisma.group.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        type: data.type as any,
        description: data.description,
        adminId: data.adminId,
        joinToken: data.joinToken,
        maxMembers: data.maxMembers,
        mealsEnabled: data.mealsEnabled ?? true,
        weeklyMenuEnabled: data.weeklyMenuEnabled ?? false,
        preferencesEnabled: data.preferencesEnabled ?? false,
        enabledPreferences: data.enabledPreferences ?? [],
        vacationModeEnabled: data.vacationModeEnabled ?? true,
      },
      include: { members: this.memberSelect },
    });
    return this.buildEntity(group);
  }

  async update(
    id: string,
    organizationId: string,
    data: Partial<{
      name: string;
      description: string | null;
      adminId: string;
      maxMembers: number | null;
      mealsEnabled: boolean;
      weeklyMenuEnabled: boolean;
      preferencesEnabled: boolean;
      enabledPreferences: string[];
      vacationModeEnabled: boolean;
      isActive: boolean;
      joinToken: string;
      joinTokenExpiresAt: Date | null;
    }>,
  ): Promise<GroupEntity> {
    // updateMany enforces organizationId in WHERE — atomic isolation check
    const result = await this.prisma.group.updateMany({
      where: { id, organizationId },
      data,
    });

    if (result.count === 0) {
      throw new NotFoundException('Group not found');
    }

    // Re-fetch with members to rebuild computed fields
    return this.findById(id, organizationId, true) as Promise<GroupEntity>;
  }

  /**
   * Soft delete — sets isActive=false. Members and audit logs preserved.
   * Uses updateMany to enforce org isolation atomically.
   */
  async softDelete(id: string, organizationId: string): Promise<void> {
    const result = await this.prisma.group.updateMany({
      where: { id, organizationId, isActive: true },
      data: { isActive: false },
    });

    if (result.count === 0) {
      throw new NotFoundException('Group not found or already archived');
    }
  }

  /**
   * Regenerate join code — atomically verifies org, sets new joinToken.
   * Old QR codes become invalid immediately.
   */
  async regenerateJoinCode(
    id: string,
    organizationId: string,
    newCode: string,
    expiresAt?: Date | null,
  ): Promise<GroupEntity> {
    const result = await this.prisma.group.updateMany({
      where: { id, organizationId },
      data: {
        joinToken: newCode,
        joinTokenExpiresAt: expiresAt ?? null,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Group not found');
    }

    return this.findById(id, organizationId, true) as Promise<GroupEntity>;
  }
}
