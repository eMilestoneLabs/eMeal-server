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

  // ── Org timezone (Pass 6, FR-TIME-011) ─────────────────────────────────────
  // Small in-process TTL cache (same pattern as dashboard.repository
  // getOrgTimezone) so hot read paths never pay a per-request PK lookup.
  private readonly orgTzCache = new Map<string, { tz: string; exp: number }>();

  async getOrganizationTimezone(organizationId: string): Promise<string> {
    const ttlMs = parseInt(process.env.ORG_TZ_CACHE_TTL_MS ?? '300000', 10);
    const hit = this.orgTzCache.get(organizationId);
    if (hit && hit.exp > Date.now()) return hit.tz;
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const tz = org?.timezone ?? 'Asia/Kolkata';
    this.orgTzCache.set(organizationId, { tz, exp: Date.now() + ttlMs });
    return tz;
  }

  // ── Entity builder — computes membership fields from included relation ─────

  private buildEntity(raw: any): GroupEntity {
    const members: Array<{ userId: string; status: string }> = raw.members ?? [];
    const activeMembers = members.filter((m) => m.status === 'active');
    const blockedMembers = members.filter((m) => m.status === 'blocked');
    // MEM-008/010 / CFG-009: pending join requests count toward capacity.
    const pendingMembers = members.filter((m) => m.status === 'pending');

    return new GroupEntity({
      ...raw,
      memberCount: activeMembers.length,
      memberIds: activeMembers.map((m) => m.userId),
      blockedMemberIds: blockedMembers.map((m) => m.userId),
      pendingCount: pendingMembers.length,
      pendingMemberIds: pendingMembers.map((m) => m.userId),
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

  /**
   * ISSUE 2 (additive): resolve the group admin's display name + the org name
   * for the read-only member detail view. Two indexed point-lookups, called
   * only when a single group's details are opened — never in list paths.
   */
  async getDetailNames(
    adminId: string | null,
    organizationId: string,
  ): Promise<{ adminName: string | null; organizationName: string | null }> {
    const [admin, org] = await Promise.all([
      adminId
        ? this.prisma.user.findUnique({
            where: { id: adminId },
            select: { name: true },
          })
        : Promise.resolve(null),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true },
      }),
    ]);
    return {
      adminName: admin?.name ?? null,
      organizationName: org?.name ?? null,
    };
  }

  /**
   * ORG-012 / GRP-005 / CFG-012: count the organization's ACTIVE (non-archived)
   * groups — drives the max-groups-per-org limit and the Create-disabled state.
   */
  async countActiveGroups(organizationId: string): Promise<number> {
    return this.prisma.group.count({
      where: { organizationId, isActive: true },
    });
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
    joinTokenExpiresAt?: Date | null;
    maxMembers?: number;
    mealsEnabled?: boolean;
    weeklyMenuEnabled?: boolean;
    dayWiseMealsEnabled?: boolean;
    preferencesEnabled?: boolean;
    enabledPreferences?: string[];
    vacationModeEnabled?: boolean;
    mealPricingEnabled?: boolean;
    // Module 02 (GRP-003) — extended metadata + approval/QR policy.
    country?: string | null;
    state?: string | null;
    city?: string | null;
    pin?: string | null;
    address?: string | null;
    timezone?: string | null;
    currency?: string | null;
    joinApprovalRequired?: boolean;
    qrExpiryDays?: number | null;
  }): Promise<GroupEntity> {
    const group = await this.prisma.group.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        type: data.type as any,
        description: data.description,
        adminId: data.adminId,
        joinToken: data.joinToken,
        joinTokenExpiresAt: data.joinTokenExpiresAt ?? null,
        maxMembers: data.maxMembers,
        mealsEnabled: data.mealsEnabled ?? true,
        weeklyMenuEnabled: data.weeklyMenuEnabled ?? false,
        dayWiseMealsEnabled: data.dayWiseMealsEnabled ?? false,
        preferencesEnabled: data.preferencesEnabled ?? false,
        enabledPreferences: data.enabledPreferences ?? [],
        vacationModeEnabled: data.vacationModeEnabled ?? true,
        mealPricingEnabled: data.mealPricingEnabled ?? false,
        // Module 02 (GRP-003) — nullable metadata, captured once at creation.
        country: data.country ?? null,
        state: data.state ?? null,
        city: data.city ?? null,
        pin: data.pin ?? null,
        address: data.address ?? null,
        timezone: data.timezone ?? null,
        currency: data.currency ?? null,
        joinApprovalRequired: data.joinApprovalRequired ?? false,
        qrExpiryDays: data.qrExpiryDays ?? null,
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
      dayWiseMealsEnabled: boolean;
      preferencesEnabled: boolean;
      enabledPreferences: string[];
      vacationModeEnabled: boolean;
      vacationRequiresApproval: boolean;
      billingCycleStartDay: number | null;
      mealPricingEnabled: boolean;
      attendanceGraceMinutes: number | null;
      attendanceDefault: string | null;
      minOptOutMinutes: number | null;
      guestAttendanceEnabled: boolean;
      maxGuestsPerMemberPerMeal: number | null;
      maxGuestsPerMemberPerDay: number | null;
      guestPricingMode: string | null;
      guestAdultPrice: number | null;
      guestChildPrice: number | null;
      guestSurcharge: number | null;
      guestRequiresApproval: boolean;
      guestCutoffMinutesBeforeClose: number | null;
      guestAdvanceBookingDays: number | null;
      guestPreferenceRequired: boolean;
      allowGuestWithoutHost: boolean;
      billNoShowGuests: boolean;
      isActive: boolean;
      archivedAt: Date | null;
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
      data: { isActive: false, archivedAt: new Date() },
    });

    if (result.count === 0) {
      throw new NotFoundException('Group not found or already archived');
    }
  }

  /**
   * GRP-018: restore an archived Group — flips isActive=true, clears archivedAt.
   * Org-isolated via updateMany WHERE. Returns the restored entity.
   */
  async restore(id: string, organizationId: string): Promise<GroupEntity> {
    const result = await this.prisma.group.updateMany({
      where: { id, organizationId, isActive: false },
      data: { isActive: true, archivedAt: null },
    });

    if (result.count === 0) {
      throw new NotFoundException('Group not found or not archived');
    }

    return this.findById(id, organizationId, true) as Promise<GroupEntity>;
  }

  /**
   * GRP-019: permanently delete a Group and all of its data. Every child table
   * that references the group is removed via ON DELETE CASCADE (members, meals,
   * schedules, attendance) plus explicit deletes for the self-contained
   * scalar-FK tables (guests, notices, vacation requests, correction requests,
   * billing ledger). Runs in one transaction — all-or-nothing.
   */
  async hardDelete(id: string, organizationId: string): Promise<void> {
    // Verify the group belongs to the org BEFORE any destructive write.
    const group = await this.prisma.group.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    await this.prisma.$transaction(async (tx) => {
      // Self-contained tables keyed by scalar groupId (no Prisma cascade).
      await tx.mealGuest.deleteMany({ where: { groupId: id } });
      await tx.notice.deleteMany({ where: { groupId: id } });
      await tx.vacationRequest.deleteMany({ where: { groupId: id } });
      await tx.attendanceCorrectionRequest.deleteMany({ where: { groupId: id } });
      await tx.billingLedgerEntry.deleteMany({ where: { groupId: id } });
      // Group row — GroupMember / Meal / MealSchedule / AttendanceRecord are
      // removed by their ON DELETE CASCADE FKs to groups.
      await tx.group.delete({ where: { id } });
    });
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
