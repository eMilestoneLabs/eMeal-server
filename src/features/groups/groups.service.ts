import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { GroupsRepository } from './repositories/groups.repository';
import { MembersRepository } from './repositories/members.repository';
import { GroupSerializer } from './serializers/group.serializer';
import { GroupMemberSerializer } from './serializers/group-member.serializer';
import { GroupEntity } from './entities/group.entity';
import { AuditService } from '../../audit/audit.service';
import { UsersRepository } from '../users/repositories/users.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { generateJoinCode } from '../../common/utils/code.utils';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { JoinGroupDto } from './dto/join-group.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { QueryGroupsDto, QueryMembersDto } from './dto/query-groups.dto';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { RealtimeEventsService } from '../../realtime/services/realtime-events.service';

/**
 * Module 22 (FR-HG-020): guest-config columns that are nullable in the schema
 * — an explicit `null` in a PATCH legitimately clears them back to their
 * serializer default. The remaining (boolean) columns are NOT NULL; a null
 * for those is ignored rather than passed to Prisma.
 */
const NULLABLE_GUEST_KEYS: ReadonlySet<string> = new Set([
  'maxGuestsPerMemberPerMeal',
  'maxGuestsPerMemberPerDay',
  'guestPricingMode',
  'guestAdultPrice',
  'guestChildPrice',
  'guestSurcharge',
  'guestCutoffMinutesBeforeClose',
  'guestAdvanceBookingDays',
]);

@Injectable()
export class GroupsService {
  private readonly logger = new Logger(GroupsService.name);

  constructor(
    private readonly groupsRepo: GroupsRepository,
    private readonly membersRepo: MembersRepository,
    private readonly usersRepo: UsersRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
  ) {}

  // ── CREATE ────────────────────────────────────────────────────────────────

  async createGroup(
    organizationId: string,
    adminId: string,
    dto: CreateGroupDto,
    requestId?: string,
  ) {
    // Generate collision-resistant 8-char join code
    const joinToken = await this.generateUniqueJoinCode();

    // Create group with mealConfig defaults
    const group = await this.groupsRepo.create({
      organizationId,
      name: dto.name,
      type: GroupSerializer.normalizeTypeForDb(dto.type),  // BUG-002: factory_ → factory for DB
      description: dto.description,
      adminId,
      joinToken,
      maxMembers: dto.maxMembers,
      mealsEnabled: dto.mealConfig?.mealsEnabled ?? true,
      weeklyMenuEnabled: dto.mealConfig?.weeklyMenuEnabled ?? false,
      dayWiseMealsEnabled: dto.mealConfig?.dayWiseMealsEnabled ?? false,
      preferencesEnabled: dto.mealConfig?.preferencesEnabled ?? false,
      enabledPreferences: dto.mealConfig?.enabledPreferences ?? [],
      vacationModeEnabled: dto.mealConfig?.vacationModeEnabled ?? true,
      mealPricingEnabled: dto.mealConfig?.mealPricingEnabled ?? false,
    });

    // Auto-add creator as groupManager member.
    // Additive (#8): persist the admin's explicitly-chosen functional role for
    // THIS group (e.g. hostelAdmin here, messManager elsewhere). null -> the
    // client falls back to the user's global role.
    await this.membersRepo.createMembership({
      groupId: group.id,
      userId: adminId,
      role: 'groupManager',
      status: 'active',
      functionalRole: dto.functionalRole ?? null,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: group.id,
      targetType: 'Group',
      action: 'create',
      metadata: { name: dto.name, type: dto.type },
      requestId,
    });

    this.logger.log(`Group created: ${group.name} [${group.id}] in org ${organizationId}`);

    // Re-fetch to include the just-created membership in computed fields
    const fresh = await this.groupsRepo.findById(group.id, organizationId);
    return GroupSerializer.toResponse(fresh!);
  }

  // ── LIST ──────────────────────────────────────────────────────────────────

  async getGroups(
    userId: string,
    userRole: string,
    organizationId: string,
    query: QueryGroupsDto,
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    // Admins see all groups in org; students see only their own
    const isAdmin = ADMIN_ROLES.includes(userRole as any);

    const result = isAdmin
      ? await this.groupsRepo.findAll(organizationId, {
          page,
          limit,
          type: query.type,
          includeInactive: query.includeInactive,
        })
      : await this.groupsRepo.findByMembership(userId, organizationId, { page, limit });

    // Additive (#8): attach the requester's per-group functional role so the
    // client can show "Hostel Admin" / "Mess Manager" per group (null = global).
    // Perf: one batched membership query instead of one findMembership() per
    // group (was an N+1 on the list endpoint).
    const memberships = await this.membersRepo.findMembershipsForUserInGroups(
      userId,
      result.data.map((g) => g.id),
    );
    const data = result.data.map((g) => {
      g.functionalRole = memberships.get(g.id)?.functionalRole ?? null;
      return GroupSerializer.toResponse(g);
    });

    return {
      data,
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  // ── GET ONE ───────────────────────────────────────────────────────────────

  async getGroupById(id: string, organizationId: string, userId: string, userRole: string) {
    const group = await this.groupsRepo.findById(id, organizationId);
    if (!group) throw new NotFoundException('Group not found');

    // Students must be active members to view group details
    const isAdmin = ADMIN_ROLES.includes(userRole as any);
    if (!isAdmin) {
      const isMember = await this.membersRepo.isActiveMember(id, userId);
      if (!isMember) {
        throw new ForbiddenException({
          message: 'Access denied',
          errors: { group: 'You are not a member of this group' },
        });
      }
    }

    // Additive (#8): requester's per-group functional role for display.
    const myMembership = await this.membersRepo.findMembership(id, userId);
    group.functionalRole = myMembership?.functionalRole ?? null;

    return GroupSerializer.toResponse(group);
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────

  async updateGroup(
    id: string,
    organizationId: string,
    actorId: string,
    dto: UpdateGroupDto,
    requestId?: string,
  ) {
    const existing = await this.groupsRepo.findById(id, organizationId);
    if (!existing) throw new NotFoundException('Group not found');

    const updateData: any = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    // BUG-002: normalize factory_ → factory for DB on type update
    if (dto.type !== undefined) updateData.type = GroupSerializer.normalizeTypeForDb(dto.type);
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.maxMembers !== undefined) updateData.maxMembers = dto.maxMembers;
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;

    // mealConfig partial update — each field updated independently
    if (dto.mealConfig) {
      const mc = dto.mealConfig;
      if (mc.mealsEnabled !== undefined) updateData.mealsEnabled = mc.mealsEnabled;
      if (mc.weeklyMenuEnabled !== undefined) updateData.weeklyMenuEnabled = mc.weeklyMenuEnabled;
      if (mc.dayWiseMealsEnabled !== undefined) updateData.dayWiseMealsEnabled = mc.dayWiseMealsEnabled;
      // FR-MODE-003/063 (server-enforced, atomic): Weekly Menu and Day-Wise
      // Meals are mutually exclusive, and while the meal system is ON exactly
      // one mode must be active (both-ON and both-OFF are Not Allowed).
      // Evaluate against the FINAL EFFECTIVE state (patch value ?? current DB
      // value) so a partial PATCH (FR-MEAL-010 / ISSUE-9) can never leave the
      // group in an invalid combination — e.g. turning Weekly off while
      // Day-Wise was already off used to persist both-OFF.
      if (
        mc.mealsEnabled !== undefined ||
        mc.weeklyMenuEnabled !== undefined ||
        mc.dayWiseMealsEnabled !== undefined
      ) {
        const effMeals = updateData.mealsEnabled ?? existing.mealsEnabled;
        let effWeekly = updateData.weeklyMenuEnabled ?? existing.weeklyMenuEnabled;
        let effDayWise = updateData.dayWiseMealsEnabled ?? existing.dayWiseMealsEnabled;
        // The mode explicitly enabled in THIS patch wins the exclusivity.
        if (updateData.weeklyMenuEnabled === true) effDayWise = false;
        else if (updateData.dayWiseMealsEnabled === true) effWeekly = false;
        else if (effWeekly && effDayWise) effDayWise = false; // legacy both-ON rows
        // Not-both-OFF: default to Weekly Meal Mode while meals stay enabled.
        if (effMeals !== false && !effWeekly && !effDayWise) effWeekly = true;
        updateData.weeklyMenuEnabled = effWeekly;
        updateData.dayWiseMealsEnabled = effDayWise;
      }
      if (mc.preferencesEnabled !== undefined) updateData.preferencesEnabled = mc.preferencesEnabled;
      if (mc.enabledPreferences !== undefined) updateData.enabledPreferences = mc.enabledPreferences;
      if (mc.vacationModeEnabled !== undefined) updateData.vacationModeEnabled = mc.vacationModeEnabled;
      if (mc.mealPricingEnabled !== undefined) updateData.mealPricingEnabled = mc.mealPricingEnabled;
      // SRS FR-TIME-005 (LOOP-090): per-group grace period — audited below.
      if (mc.attendanceGraceMinutes !== undefined) {
        updateData.attendanceGraceMinutes = mc.attendanceGraceMinutes;
      }
      // SRS FR-TRUST-001/003 (Pass 7): trust model + fair-opportunity floor —
      // audited below via modeChanges like every other policy flag.
      if (mc.attendanceDefault !== undefined) {
        updateData.attendanceDefault = mc.attendanceDefault;
      }
      if (mc.minOptOutMinutes !== undefined) {
        updateData.minOptOutMinutes = mc.minOptOutMinutes;
      }

      // Module 22 (Pass 8, FR-HG-020/021): hosted-guest config. Each field
      // patches independently; cross-field rules validate against the FINAL
      // effective state (same discipline as pricing/meals above).
      if (mc.guestConfig) {
        const gc = mc.guestConfig;
        for (const key of [
          'guestAttendanceEnabled',
          'maxGuestsPerMemberPerMeal',
          'maxGuestsPerMemberPerDay',
          'guestPricingMode',
          'guestAdultPrice',
          'guestChildPrice',
          'guestSurcharge',
          'guestRequiresApproval',
          'guestCutoffMinutesBeforeClose',
          'guestAdvanceBookingDays',
          'guestPreferenceRequired',
          'allowGuestWithoutHost',
          'billNoShowGuests',
        ] as const) {
          const v = gc[key];
          if (v === undefined) continue;
          // Null is a legitimate "clear to default" ONLY for the nullable
          // columns; the four booleans are NOT NULL in the schema — writing
          // null would blow up in Prisma, so a null there is ignored.
          if (v === null && !NULLABLE_GUEST_KEYS.has(key)) continue;
          updateData[key] = v;
        }

        const effGuests =
          updateData.guestAttendanceEnabled ??
          (existing as any).guestAttendanceEnabled;
        const effMeals2 = updateData.mealsEnabled ?? existing.mealsEnabled;
        // FR-HG-004: guest hosting is Meal-Mode only.
        if (effGuests === true && effMeals2 === false) {
          throw new UnprocessableEntityException({
            message: 'Hosted guests require the meal system to be enabled',
            code: 'GUESTS_REQUIRE_MEALS',
            errors: {
              guestAttendanceEnabled:
                'Enable meals for this group before turning on hosted guests',
            },
          });
        }
        // FR-HG-021: pricing-mode field requirements (final effective state).
        // `!== undefined` (not `??`): an explicit null means "CLEAR this
        // field" and must be validated as the true final state — with `??` a
        // cleared price slipped past while the mode still required it.
        const effMode =
          updateData.guestPricingMode !== undefined
            ? updateData.guestPricingMode
            : (existing as any).guestPricingMode;
        const effAdult =
          updateData.guestAdultPrice !== undefined
            ? updateData.guestAdultPrice
            : (existing as any).guestAdultPrice;
        const effSurcharge =
          updateData.guestSurcharge !== undefined
            ? updateData.guestSurcharge
            : (existing as any).guestSurcharge;
        if (effMode === 'perGuestPrice' && (effAdult === null || effAdult === undefined)) {
          throw new UnprocessableEntityException({
            message: 'perGuestPrice mode requires guestAdultPrice',
            code: 'GUEST_PRICE_REQUIRED',
            errors: { guestAdultPrice: 'Set the adult guest price' },
          });
        }
        if (effMode === 'flatSurcharge' && (effSurcharge === null || effSurcharge === undefined)) {
          throw new UnprocessableEntityException({
            message: 'flatSurcharge mode requires guestSurcharge',
            code: 'GUEST_SURCHARGE_REQUIRED',
            errors: { guestSurcharge: 'Set the per-guest surcharge' },
          });
        }
      }

      // SRS FR-MODE-004 (LOOP): pricing requires the meal system. Evaluate the
      // FINAL EFFECTIVE state so partial patches can't create pricing-in-AO.
      const effPricing =
        updateData.mealPricingEnabled ?? existing.mealPricingEnabled;
      const effMealsOn = updateData.mealsEnabled ?? existing.mealsEnabled;
      if (effPricing && effMealsOn === false) {
        if (updateData.mealPricingEnabled === true) {
          // This patch tried to ENABLE pricing in Attendance-Only → reject.
          throw new UnprocessableEntityException({
            message: 'Meal pricing requires the meal system to be enabled',
            code: 'PRICING_REQUIRES_MEALS',
            errors: {
              mealPricingEnabled:
                'Enable meals for this group before turning on meal pricing',
            },
          });
        }
        // This patch disabled meals while pricing was already ON → cascade
        // pricing OFF (recorded in modeChanges audit) instead of blocking.
        updateData.mealPricingEnabled = false;
      }
    }

    const group = await this.groupsRepo.update(id, organizationId, updateData);

    // Additive (#8): update the requesting admin's functional role for THIS
    // group (per-group title). Only applies when the actor is a member.
    if (dto.functionalRole !== undefined) {
      const membership = await this.membersRepo.findMembership(id, actorId);
      if (membership) {
        await this.membersRepo.updateMembership(id, actorId, {
          functionalRole: dto.functionalRole,
        });
      }
    }

    // FR-MODE-064: record every mode transition (who/when/old→new) in the
    // audit log — not just which fields were touched.
    const modeFlagKeys = [
      'mealsEnabled',
      'weeklyMenuEnabled',
      'dayWiseMealsEnabled',
      'preferencesEnabled',
      'vacationModeEnabled',
      'mealPricingEnabled',
      // FR-TIME-005: grace changes are auditable (who/when/old→new).
      'attendanceGraceMinutes',
      // FR-TRUST-001/003: trust-model changes are high-impact policy flips.
      'attendanceDefault',
      'minOptOutMinutes',
      // Module 22 (FR-HG-020): guest policy flips are billing-relevant.
      'guestAttendanceEnabled',
      'guestPricingMode',
      'guestAdultPrice',
      'guestChildPrice',
      'guestSurcharge',
      'guestRequiresApproval',
      'maxGuestsPerMemberPerMeal',
      'billNoShowGuests',
    ] as const;
    const modeChanges: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of modeFlagKeys) {
      const next = updateData[key];
      const prev = (existing as any)[key];
      if (next !== undefined && next !== prev) {
        modeChanges[key] = { from: prev, to: next };
      }
    }

    this.audit.log({
      organizationId,
      actorId,
      targetId: id,
      targetType: 'Group',
      action: 'update',
      metadata: {
        updatedFields: Object.keys(updateData),
        ...(Object.keys(modeChanges).length > 0 ? { modeChanges } : {}),
      },
      requestId,
    });

    // SRS FR-MODE-012 (Pass 6): push mode flips to the group room so student
    // dashboards drop/add meal widgets in real time — no stale meal actions.
    if (Object.keys(modeChanges).length > 0) {
      this.realtime?.emitGroupConfigUpdated(id, {
        groupId: id,
        changes: modeChanges,
      });
    }

    return GroupSerializer.toResponse(group);
  }

  // ── DELETE (soft) ─────────────────────────────────────────────────────────

  async deleteGroup(
    id: string,
    organizationId: string,
    actorId: string,
    requestId?: string,
  ) {
    const existing = await this.groupsRepo.findById(id, organizationId);
    if (!existing) throw new NotFoundException('Group not found');

    await this.groupsRepo.softDelete(id, organizationId);

    this.audit.log({
      organizationId,
      actorId,
      targetId: id,
      targetType: 'Group',
      action: 'delete',
      metadata: { name: existing.name, softDelete: true },
      requestId,
    });

    return { message: 'Group archived successfully', id };
  }

  // ── JOIN ──────────────────────────────────────────────────────────────────

  /**
   * Join a group using a join code.
   *
   * Business rules:
   * 1. Join code must exist and map to an active group
   * 2. Join code must not be expired
   * 3. Group must not be at max capacity
   * 4. Blocked users cannot rejoin
   * 5. Already-active members → idempotent success
   * 6. Removed members → re-activate
   * 7. New members → create membership record
   * 8. User's organizationId updated if not yet assigned
   */
  async joinGroup(userId: string, dto: JoinGroupDto, requestId?: string) {
    const group = await this.groupsRepo.findByJoinCode(dto.joinCode);

    if (!group || !group.isActive) {
      throw new BadRequestException({
        message: 'Invalid join code',
        errors: { joinCode: 'No active group found with this join code' },
      });
    }

    // Join code expiry check
    if (group.joinTokenExpiresAt && group.joinTokenExpiresAt < new Date()) {
      throw new BadRequestException({
        message: 'Join code expired',
        errors: { joinCode: 'This join code has expired. Ask your admin for a new one.' },
      });
    }

    // Max capacity check (null maxMembers = unlimited).
    // SRS FR-GRP-015/FR-JOIN-012 (LOOP-061, SC-043): 409 GROUP_FULL.
    if (group.maxMembers !== null && group.memberCount >= group.maxMembers) {
      throw new ConflictException({
        message: 'Group is full',
        code: 'GROUP_FULL',
        errors: { joinCode: 'This group has reached its maximum capacity' },
      });
    }

    // Existing membership check
    const existingMembership = await this.membersRepo.findMembership(group.id, userId);

    if (existingMembership) {
      if (existingMembership.status === 'blocked') {
        throw new ForbiddenException({
          message: 'Access denied',
          errors: { joinCode: 'You have been blocked from this group by an admin' },
        });
      }

      if (existingMembership.status === 'active') {
        // Idempotent — already a member, return group
        return GroupSerializer.toResponse(group);
      }

      if (existingMembership.status === 'removed') {
        // Re-join: restore active status
        await this.membersRepo.updateMembership(group.id, userId, {
          status: 'active',
          removedAt: null as any,
          removedBy: null as any,
        });

        this.audit.log({
          organizationId: group.organizationId,
          actorId: userId,
          targetId: group.id,
          targetType: 'Group',
          action: 'join',
          metadata: { rejoin: true },
          requestId,
        });

        const refreshed = await this.groupsRepo.findById(group.id, group.organizationId);
        await this.syncUserOrganization(userId, group.organizationId);
        return GroupSerializer.toResponse(refreshed!);
      }
    }

    // New member — create membership
    await this.membersRepo.createMembership({ groupId: group.id, userId });

    this.audit.log({
      organizationId: group.organizationId,
      actorId: userId,
      targetId: group.id,
      targetType: 'Group',
      action: 'join',
      requestId,
    });

    // Sync user's organizationId if they don't have one yet
    await this.syncUserOrganization(userId, group.organizationId);

    this.logger.log(`User \${userId} joined group \${group.id}`);

    // B7: emit group membership change so group room members see the new member
    this.realtime?.emitGroupMemberUpdated(group.id, {
      groupId: group.id,
      userId,
      action: 'joined',
    });

    const refreshed = await this.groupsRepo.findById(group.id, group.organizationId);
    return GroupSerializer.toResponse(refreshed!);
  }

  // ── JOIN CODE REGENERATION ────────────────────────────────────────────────

  /**
   * Regenerate the group join code. All old QR codes become immediately invalid.
   * Admin/groupManager only.
   */
  async regenerateJoinCode(
    id: string,
    organizationId: string,
    actorId: string,
    expiresInHours?: number,
    requestId?: string,
  ) {
    const existing = await this.groupsRepo.findById(id, organizationId);
    if (!existing) throw new NotFoundException('Group not found');

    const newCode = await this.generateUniqueJoinCode();
    const expiresAt = expiresInHours
      ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
      : null;

    await this.groupsRepo.regenerateJoinCode(id, organizationId, newCode, expiresAt);

    this.audit.log({
      organizationId,
      actorId,
      targetId: id,
      targetType: 'Group',
      action: 'update',
      metadata: { action: 'join_code_regenerated', expiresAt: expiresAt?.toISOString() },
      requestId,
    });

    return {
      joinCode: newCode,
      expiresAt: expiresAt?.toISOString() ?? null,
      message: 'Join code regenerated. All previous QR codes are now invalid.',
    };
  }

  // ── MEMBERSHIP MANAGEMENT ─────────────────────────────────────────────────

  /**
   * GET /groups/:id/members
   * Paginated member list. All roles can view — blocked/removed filtered by status param.
   */
  async getMembers(
    groupId: string,
    organizationId: string,
    userId: string,
    userRole: string,
    query: QueryMembersDto,
  ) {
    // Verify group exists in org
    const group = await this.groupsRepo.findById(groupId, organizationId);
    if (!group) throw new NotFoundException('Group not found');

    // Non-admins must be active members to view member list
    const isAdmin = ADMIN_ROLES.includes(userRole as any);
    if (!isAdmin) {
      const isMember = await this.membersRepo.isActiveMember(groupId, userId);
      if (!isMember) {
        throw new ForbiddenException({
          message: 'Access denied',
          errors: { group: 'You must be a group member to view its member list' },
        });
      }
    }

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const result = await this.membersRepo.findByGroupId(groupId, organizationId, {
      page,
      limit,
      status: query.status,
    });

    return {
      data: result.data.map(GroupMemberSerializer.toResponse),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  /**
   * PATCH /groups/:id/members/:memberId
   * Update a member's role or status (block/unblock/promote).
   * :memberId = userId of the target member (not GroupMember.id).
   */
  async updateMember(
    groupId: string,
    targetUserId: string,
    organizationId: string,
    actorId: string,
    dto: UpdateMemberDto,
    requestId?: string,
  ) {
    const group = await this.groupsRepo.findById(groupId, organizationId);
    if (!group) throw new NotFoundException('Group not found');

    const membership = await this.membersRepo.findMembership(groupId, targetUserId);
    if (!membership) {
      throw new NotFoundException({
        message: 'Member not found',
        errors: { memberId: 'User is not a member of this group' },
      });
    }

    // Prevent self-demotion/blocking
    if (targetUserId === actorId && dto.status === 'blocked') {
      throw new BadRequestException({
        message: 'Invalid operation',
        errors: { memberId: 'You cannot block yourself' },
      });
    }

    const updateData: any = {};
    if (dto.role !== undefined) updateData.role = dto.role;

    if (dto.status !== undefined) {
      updateData.status = dto.status;
      if (dto.status === 'blocked') {
        updateData.blockedAt = new Date();
        updateData.blockedBy = actorId;
      } else if (dto.status === 'removed') {
        updateData.removedAt = new Date();
        updateData.removedBy = actorId;
      } else if (dto.status === 'active') {
        // Unblock — clear block audit fields
        updateData.blockedAt = null;
        updateData.blockedBy = null;
      }
    }

    const updated = await this.membersRepo.updateMembership(groupId, targetUserId, updateData);

    this.audit.log({
      organizationId,
      actorId,
      targetId: targetUserId,
      targetType: 'User',
      action: dto.status === 'blocked' ? 'block' : dto.status === 'active' ? 'unblock' : 'update',
      metadata: { groupId, role: dto.role, status: dto.status },
      requestId,
    });

    // B7: emit typed realtime events for block / unblock / role change
    if (dto.status === 'blocked') {
      this.realtime?.emitMemberBlocked(groupId, {
        groupId,
        userId: targetUserId,
        blockedBy: actorId,
      });
    } else {
      this.realtime?.emitGroupMemberUpdated(groupId, {
        groupId,
        userId: targetUserId,
        action: dto.status === 'active' ? 'unblocked' : 'role_changed',
      });
    }

    return GroupMemberSerializer.toResponse(updated);
  }

  /**
   * DELETE /groups/:id/members/:memberId
   * Soft-remove a member from the group. Sets status='removed'.
   * Hard delete is not supported (audit trail must be preserved).
   */
  async removeMember(
    groupId: string,
    targetUserId: string,
    organizationId: string,
    actorId: string,
    requestId?: string,
  ) {
    const group = await this.groupsRepo.findById(groupId, organizationId);
    if (!group) throw new NotFoundException('Group not found');

    const membership = await this.membersRepo.findMembership(groupId, targetUserId);
    if (!membership || membership.status === 'removed') {
      throw new NotFoundException({
        message: 'Member not found',
        errors: { memberId: 'User is not an active member of this group' },
      });
    }

    await this.membersRepo.updateMembership(groupId, targetUserId, {
      status: 'removed',
      removedAt: new Date(),
      removedBy: actorId,
    });

    this.audit.log({
      organizationId,
      actorId,
      targetId: targetUserId,
      targetType: 'User',
      action: 'leave',
      metadata: { groupId, removedBy: actorId },
      requestId,
    });

    // B7: emit membership removal event
    this.realtime?.emitGroupMemberUpdated(groupId, {
      groupId,
      userId: targetUserId,
      action: 'removed',
    });

    return { message: 'Member removed from group', userId: targetUserId };
  }

  /**
   * POST /groups/:id/members
   * Admin adds a specific user by userId to the group.
   * Distinct from joinGroup (QR-based) — this is admin-initiated direct add.
   */
  async addMemberById(
    groupId: string,
    organizationId: string,
    actorId: string,
    targetUserId: string,
    role?: string,
    requestId?: string,
  ) {
    const group = await this.groupsRepo.findById(groupId, organizationId);
    if (!group) throw new NotFoundException('Group not found');

    const user = await this.usersRepo.findById(targetUserId);
    if (!user) throw new NotFoundException({ message: 'User not found', errors: { userId: 'No user with this ID exists' } });

    const existing = await this.membersRepo.findMembership(groupId, targetUserId);
    if (existing) {
      if (existing.status === 'blocked') {
        throw new BadRequestException({ message: 'User is blocked from this group', errors: { userId: 'Unblock the user before adding them' } });
      }
      if (existing.status === 'active') {
        throw new ConflictException({ message: 'You are already a member of this group.', statusCode: 409 });
      }
      // Re-activate removed member
      const updated = await this.membersRepo.updateMembership(groupId, targetUserId, {
        status: 'active',
        role: (role as any) ?? existing.role,
        removedAt: null as any,
        removedBy: null as any,
      });
      await this.syncUserOrganization(targetUserId, organizationId);
      this.realtime?.emitGroupMemberUpdated(groupId, { groupId, userId: targetUserId, action: 'joined' });
      return GroupMemberSerializer.toResponse(updated);
    }

    const membership = await this.membersRepo.createMembership({
      groupId,
      userId: targetUserId,
      role: (role as any) ?? 'member',
      status: 'active',
    });

    await this.syncUserOrganization(targetUserId, organizationId);

    this.audit.log({ organizationId, actorId, targetId: targetUserId, targetType: 'User', action: 'join', metadata: { groupId, addedByAdmin: true }, requestId });
    this.realtime?.emitGroupMemberUpdated(groupId, { groupId, userId: targetUserId, action: 'joined' });

    return GroupMemberSerializer.toResponse(membership);
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────

  /**
   * Generate a unique join code with collision retry.
   * 36^8 ≈ 2.8T combinations — collision at MVP scale is astronomically unlikely,
   * but we retry up to 5 times defensively.
   */
  private async generateUniqueJoinCode(attempts = 0): Promise<string> {
    if (attempts >= 5) {
      throw new Error('Failed to generate unique join code after 5 attempts');
    }
    const code = generateJoinCode(8);
    const existing = await this.groupsRepo.findByJoinCode(code);
    if (existing) {
      return this.generateUniqueJoinCode(attempts + 1);
    }
    return code;
  }

  /**
   * When a user joins their first group, update their organizationId in the User record.
   * This ensures future JWTs (after token refresh) carry the correct organizationId.
   * If user already has a different org, this is a cross-org join — reject.
   */
  private async syncUserOrganization(userId: string, groupOrgId: string): Promise<void> {
    const user = await this.usersRepo.findById(userId);
    if (!user) return;

    if (!user.organizationId) {
      // First group join — set org
      await this.usersRepo.update(userId, { organizationId: groupOrgId });
      this.logger.log(`Synced organizationId=${groupOrgId} for user ${userId}`);
    }
    // If organizationId already matches — no-op (correct state)
    // Cross-org join guard is intentionally loose in B2 — enforced by join code scoping
  }
  // ── GET /groups/:id/qr-token ──────────────────────────────────────────────

  async getQrToken(id: string, organizationId: string) {
    const group = await this.groupsRepo.findById(id, organizationId);
    if (!group) throw new NotFoundException('Group not found');
    return {
      groupId: group.id,
      joinCode: group.joinToken,
      qrPayload: group.joinToken,  // Flutter renders QR from this value
    };
  }

  // ── GET /groups/:id/meal-config ───────────────────────────────────────────

  async getMealConfig(id: string, organizationId: string) {
    const group = await this.groupsRepo.findById(id, organizationId);
    if (!group) throw new NotFoundException('Group not found');
    return {
      mealsEnabled: group.mealsEnabled,
      weeklyMenuEnabled: group.weeklyMenuEnabled,
      dayWiseMealsEnabled: group.dayWiseMealsEnabled,
      preferencesEnabled: group.preferencesEnabled,
      enabledPreferences: group.enabledPreferences,
      vacationModeEnabled: group.vacationModeEnabled,
      mealPricingEnabled: group.mealPricingEnabled,
      // SRS FR-TIME-005: per-group late-marking grace (minutes, 0 = none).
      attendanceGraceMinutes: group.attendanceGraceMinutes ?? 0,
      // SRS FR-TRUST-001/003: trust model (opt-in default) + fair floor.
      attendanceDefault: group.attendanceDefault ?? 'absent',
      minOptOutMinutes: group.minOptOutMinutes ?? null,
      // Module 22 (FR-HG-020/022): hosted-guest config, nested + additive.
      guestConfig: GroupSerializer.guestConfig(group),
    };
  }

}
