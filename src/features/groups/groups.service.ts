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
import {
  encodeQrPayload,
  decodeQrPayload,
  isSignedQrPayload,
} from '../../common/utils/qr-payload.util';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { JoinGroupDto } from './dto/join-group.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { QueryGroupsDto, QueryMembersDto } from './dto/query-groups.dto';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { RealtimeEventsService } from '../../realtime/services/realtime-events.service';
import { ConfigService } from '@nestjs/config';
import { NoticesService } from '../notices/notices.service';
import { NotificationsService } from '../notifications/notifications.service';

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
    private readonly config: ConfigService,
    @Optional() @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
    // Module 02: bell + push for group/member lifecycle. @Optional so unit
    // tests can construct the service without wiring these providers.
    @Optional() private readonly notices: NoticesService | null = null,
    @Optional() private readonly notifications: NotificationsService | null = null,
  ) {}

  /** Typed access to the `groups.*` configuration namespace (CFG-001). */
  private groupsCfg<T>(key: string, fallback: T): T {
    return this.config.get<T>(`groups.${key}`) ?? fallback;
  }

  /**
   * GRP-004 / CFG-002/003/004: the maximum member capacity an admin may
   * configure for a Group, based on their Organization Role. Config-driven with
   * a documented default fallback for unlisted roles.
   */
  private roleMemberLimit(role: string): number {
    const limits = this.groupsCfg<Record<string, number>>(
      'roleMemberLimits',
      {},
    );
    const fallback = this.groupsCfg<number>('defaultRoleMemberLimit', 50);
    const v = limits?.[role];
    return typeof v === 'number' && v > 0 ? v : fallback;
  }

  // ── LIFECYCLE NOTIFICATIONS (bell + best-effort push) ──────────────────────
  // All best-effort and fire-and-forget: a notification failure must NEVER break
  // the membership write (NTF/FR-NOTX-016). The bell (Notice) is the reliable
  // in-app channel; FCM push is a best-effort second layer.

  /** NTF-001: alert org admins that a member submitted a join request. */
  private alertAdminsJoinRequest(
    organizationId: string,
    requesterId: string,
    requesterName: string,
    groupName: string,
  ): void {
    void this.notices?.createRequestAlert({
      organizationId,
      groupId: null, // org-wide so every admin sees it regardless of selected group
      actorId: requesterId,
      title: 'New join request',
      body: `${requesterName} requested to join ${groupName}. Tap to review.`,
      priority: 'high',
      linkType: 'groupJoinRequests',
      audience: 'admins',
    });
  }

  /** NTF-004: alert org admins that a group reached maximum capacity. */
  private alertAdminsGroupFull(
    organizationId: string,
    actorId: string,
    groupName: string,
  ): void {
    void this.notices?.createRequestAlert({
      organizationId,
      groupId: null,
      actorId,
      title: 'Group is full',
      body: `${groupName} has reached its maximum capacity.`,
      priority: 'normal',
      linkType: 'groupMembers',
      audience: 'admins',
    });
  }

  /**
   * NTF-002/003 / MEM-022: drop a targeted notice into ONE member's bell for a
   * lifecycle event (approved/rejected/blocked/unblocked/removed/reinvited), and
   * optionally mirror it as an FCM push.
   */
  private alertMember(params: {
    organizationId: string;
    actorId: string;
    targetUserId: string;
    groupName: string;
    title: string;
    body: string;
    linkType?: string;
    push?: 'joined' | 'removed' | 'blocked';
  }): void {
    void this.notices?.createMemberAlert({
      organizationId: params.organizationId,
      actorId: params.actorId,
      targetUserId: params.targetUserId,
      title: params.title,
      body: params.body,
      linkType: params.linkType ?? 'myGroups',
    });
    if (params.push) {
      void this.notifications?.notifyGroupMembership({
        organizationId: params.organizationId,
        userId: params.targetUserId,
        groupName: params.groupName,
        action: params.push,
      });
    }
  }

  // ── CREATE ────────────────────────────────────────────────────────────────

  async createGroup(
    organizationId: string,
    adminId: string,
    dto: CreateGroupDto,
    requestId?: string,
  ) {
    // ORG-012/013 / GRP-005/010 / CFG-012/013: enforce the max-groups-per-org
    // limit BEFORE any write. Reached → 409 so the client keeps Create disabled.
    const maxGroups = this.groupsCfg<number>('maxGroupsPerOrg', 5);
    const currentGroups = await this.groupsRepo.countActiveGroups(organizationId);
    if (currentGroups >= maxGroups) {
      throw new ConflictException({
        message: `Group limit reached (${maxGroups}). Archive or delete a group to create a new one.`,
        code: 'GROUP_LIMIT_REACHED',
        errors: { organization: `Maximum of ${maxGroups} groups allowed` },
      });
    }

    // GRP-004 / CFG-002/003/004: Maximum Members entered by the admin must not
    // exceed the configured limit for their Organization Role. The creator's
    // role is resolved from their User record (one indexed PK lookup at create).
    if (dto.maxMembers !== undefined && dto.maxMembers !== null) {
      const creator = await this.usersRepo.findById(adminId);
      const limit = this.roleMemberLimit(creator?.role ?? 'student');
      if (dto.maxMembers > limit) {
        throw new UnprocessableEntityException({
          message: `Maximum Members (${dto.maxMembers}) exceeds your role limit of ${limit}.`,
          code: 'MEMBER_LIMIT_EXCEEDED',
          errors: { maxMembers: `Must be ${limit} or fewer for your role` },
        });
      }
    }

    // Generate collision-resistant join code (length is config-driven, CFG-015).
    const joinToken = await this.generateUniqueJoinCode();

    // GRP-013 / CFG-014: resolve the QR expiry policy (days) — dto value, else
    // the configured default (0 = Never). Compute the concrete deadline once.
    const qrExpiryDays =
      dto.qrExpiryDays ?? this.groupsCfg<number>('defaultQrExpiryDays', 0);
    const joinTokenExpiresAt =
      qrExpiryDays && qrExpiryDays > 0
        ? new Date(Date.now() + qrExpiryDays * 24 * 60 * 60 * 1000)
        : null;

    // Create group with mealConfig defaults
    const group = await this.groupsRepo.create({
      organizationId,
      name: dto.name,
      type: GroupSerializer.normalizeTypeForDb(dto.type),  // BUG-002: factory_ → factory for DB
      description: dto.description,
      adminId,
      joinToken,
      joinTokenExpiresAt,
      maxMembers: dto.maxMembers,
      mealsEnabled: dto.mealConfig?.mealsEnabled ?? true,
      weeklyMenuEnabled: dto.mealConfig?.weeklyMenuEnabled ?? false,
      dayWiseMealsEnabled: dto.mealConfig?.dayWiseMealsEnabled ?? false,
      preferencesEnabled: dto.mealConfig?.preferencesEnabled ?? false,
      enabledPreferences: dto.mealConfig?.enabledPreferences ?? [],
      vacationModeEnabled: dto.mealConfig?.vacationModeEnabled ?? true,
      mealPricingEnabled: dto.mealConfig?.mealPricingEnabled ?? false,
      // Module 02 (GRP-003) — extended metadata captured once at creation.
      country: dto.country ?? null,
      state: dto.state ?? null,
      city: dto.city ?? null,
      address: dto.address ?? null,
      timezone: dto.timezone ?? null,
      currency: dto.currency ?? null,
      joinApprovalRequired: dto.joinApprovalRequired ?? false,
      qrExpiryDays: qrExpiryDays && qrExpiryDays > 0 ? qrExpiryDays : null,
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
      metadata: {
        name: dto.name,
        type: dto.type,
        // GRP-003 / ORG-016: record the immutable metadata + policy at creation.
        country: dto.country ?? null,
        state: dto.state ?? null,
        city: dto.city ?? null,
        currency: dto.currency ?? null,
        timezone: dto.timezone ?? null,
        maxMembers: dto.maxMembers ?? null,
        joinApprovalRequired: dto.joinApprovalRequired ?? false,
        qrExpiryDays: qrExpiryDays && qrExpiryDays > 0 ? qrExpiryDays : null,
      },
      requestId,
    });

    this.logger.log(`Group created: ${group.name} [${group.id}] in org ${organizationId}`);

    // Re-fetch to include the just-created membership in computed fields
    const fresh = await this.groupsRepo.findById(group.id, organizationId);
    return GroupSerializer.toResponse(fresh!);
  }

  // ── LIMITS (ORG-013 / GRP-010 / CFG-013) ───────────────────────────────────

  /**
   * Configuration-driven limits for the current organization + requester role,
   * so the client can disable the Create-Group action at the limit (GRP-010)
   * and cap the Maximum-Members input (GRP-004) without hardcoding anything.
   */
  async getGroupLimits(organizationId: string, role: string) {
    const maxGroups = this.groupsCfg<number>('maxGroupsPerOrg', 5);
    const currentGroups = await this.groupsRepo.countActiveGroups(organizationId);
    return {
      maxGroups,
      currentGroups,
      canCreateGroup: currentGroups < maxGroups,
      roleMemberLimit: this.roleMemberLimit(role),
    };
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
    // GRP-018/019: admins may open ARCHIVED groups (to restore / permanently
    // delete them); members only ever see active groups.
    const isAdmin = ADMIN_ROLES.includes(userRole as any);
    const group = await this.groupsRepo.findById(id, organizationId, isAdmin);
    if (!group) throw new NotFoundException('Group not found');

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

    // Additive (ISSUE 2): admin + organization names for the member detail view.
    const names = await this.groupsRepo.getDetailNames(
      group.adminId,
      organizationId,
    );
    group.adminName = names.adminName;
    group.organizationName = names.organizationName;

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
      // Pass 11 (FR-VACX-001): approval-gated vacation — audited below.
      if (mc.vacationRequiresApproval !== undefined) {
        updateData.vacationRequiresApproval = mc.vacationRequiresApproval;
      }
      // Pass 12 (FR-BILLX-020): billing cycle start day (null = calendar
      // month) — validated 1–28 by the DTO, audited below (LOOP-033/GAP-021).
      if (mc.billingCycleStartDay !== undefined) {
        updateData.billingCycleStartDay = mc.billingCycleStartDay;
      }
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
      // Pass 11/12: policy + billing-cycle flips are high-impact (LOOP-033).
      'vacationRequiresApproval',
      'billingCycleStartDay',
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
      metadata: { name: existing.name, softDelete: true, archived: true },
      requestId,
    });

    return { message: 'Group archived successfully', id };
  }

  // ── RESTORE (GRP-018) ──────────────────────────────────────────────────────

  /**
   * GRP-018: restore a previously archived Group. Admin-only (guarded at the
   * controller). Un-hides it from dashboards + switchers with all historical
   * data intact.
   */
  async restoreGroup(
    id: string,
    organizationId: string,
    actorId: string,
    requestId?: string,
  ) {
    // includeInactive so we can find the archived row.
    const existing = await this.groupsRepo.findById(id, organizationId, true);
    if (!existing) throw new NotFoundException('Group not found');
    if (existing.isActive) {
      throw new ConflictException({
        message: 'Group is not archived',
        code: 'GROUP_NOT_ARCHIVED',
        errors: { id: 'Only archived groups can be restored' },
      });
    }

    const restored = await this.groupsRepo.restore(id, organizationId);

    this.audit.log({
      organizationId,
      actorId,
      targetId: id,
      targetType: 'Group',
      action: 'update',
      metadata: { name: existing.name, restored: true },
      requestId,
    });

    this.logger.log(`Group restored: ${existing.name} [${id}] in org ${organizationId}`);
    return GroupSerializer.toResponse(restored);
  }

  // ── PERMANENT DELETE (GRP-019) ─────────────────────────────────────────────

  /**
   * GRP-019: permanently delete a Group and ALL of its data. Irreversible —
   * requires explicit danger confirmation at the client. The repository runs
   * every child delete in one transaction. Admin-only (controller-guarded).
   */
  async permanentDeleteGroup(
    id: string,
    organizationId: string,
    actorId: string,
    requestId?: string,
  ) {
    const existing = await this.groupsRepo.findById(id, organizationId, true);
    if (!existing) throw new NotFoundException('Group not found');

    // Snapshot identity for the audit trail BEFORE the row is gone (ORG-016).
    this.audit.log({
      organizationId,
      actorId,
      targetId: id,
      targetType: 'Group',
      action: 'delete',
      metadata: {
        name: existing.name,
        permanent: true,
        memberCount: existing.memberCount,
      },
      requestId,
    });

    await this.groupsRepo.hardDelete(id, organizationId);

    this.logger.warn(
      `Group PERMANENTLY DELETED: ${existing.name} [${id}] by ${actorId} in org ${organizationId}`,
    );
    return { message: 'Group permanently deleted', id };
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
    // GRP-012: accept EITHER a raw join code OR a signed QR payload. A signed
    // payload is verified (HMAC) and expiry-checked here before we trust its
    // embedded join token; a tampered/forged payload is rejected outright.
    let joinCode = dto.joinCode;
    if (isSignedQrPayload(dto.joinCode)) {
      const secret = this.groupsCfg<string>('qrSigningSecret', 'emeal-qr-dev-secret');
      const payload = decodeQrPayload(dto.joinCode, secret);
      if (!payload) {
        throw new BadRequestException({
          message: 'Invalid QR code',
          errors: { joinCode: 'This QR code is invalid or has been tampered with' },
        });
      }
      if (payload.e && new Date(payload.e) < new Date()) {
        throw new BadRequestException({
          message: 'QR code expired',
          errors: { joinCode: 'This QR code has expired. Ask your admin for a new one.' },
        });
      }
      joinCode = payload.t;
    }

    const group = await this.groupsRepo.findByJoinCode(joinCode);

    if (!group || !group.isActive) {
      throw new BadRequestException({
        message: 'Invalid join code',
        errors: { joinCode: 'No active group found with this join code' },
      });
    }

    // GRP-014 / Join code expiry check — expired codes reject new joins.
    if (group.joinTokenExpiresAt && group.joinTokenExpiresAt < new Date()) {
      throw new BadRequestException({
        message: 'Join code expired',
        errors: { joinCode: 'This join code has expired. Ask your admin for a new one.' },
      });
    }

    // MEM-004: does this group gate joins behind admin approval?
    const approvalRequired = group.joinApprovalRequired === true;

    // Capacity check (null maxMembers = unlimited). CFG-009/010 / MEM-008/010:
    // pending requests count toward capacity so pending can never exceed the
    // remaining slots. SRS FR-GRP-015/FR-JOIN-012 (LOOP-061): 409 GROUP_FULL.
    const occupied = group.memberCount + group.pendingCount;
    if (group.maxMembers !== null && occupied >= group.maxMembers) {
      // NTF-004: let admins know the group is at capacity.
      this.alertAdminsGroupFull(group.organizationId, userId, group.name);
      throw new ConflictException({
        message: 'Group Full – Contact Administrator',
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
        // Idempotent — already a member, return group.
        return this.joinResponse(group, 'active');
      }

      if (existingMembership.status === 'pending') {
        // MEM-004: idempotent — request already awaiting approval.
        return this.joinResponse(group, 'pending');
      }

      if (existingMembership.status === 'removed') {
        // MEM-021: rejoin follows normal join rules — including approval mode.
        const nextStatus = approvalRequired ? 'pending' : 'active';
        await this.membersRepo.updateMembership(group.id, userId, {
          status: nextStatus,
          removedAt: null as any,
          removedBy: null as any,
          reviewedBy: null as any,
          reviewedAt: null as any,
          reviewNote: null as any,
          ...(dto.functionalRole
            ? { functionalRole: dto.functionalRole }
            : {}),
        });

        this.audit.log({
          organizationId: group.organizationId,
          actorId: userId,
          targetId: group.id,
          targetType: 'Group',
          action: 'join',
          metadata: { rejoin: true, pending: approvalRequired },
          requestId,
        });

        if (approvalRequired) {
          const requester = await this.usersRepo.findById(userId);
          this.alertAdminsJoinRequest(
            group.organizationId,
            userId,
            requester?.name ?? 'A member',
            group.name,
          );
          return this.joinResponse(group, 'pending');
        }

        const refreshed = await this.groupsRepo.findById(group.id, group.organizationId);
        await this.syncUserOrganization(userId, group.organizationId);
        this.realtime?.emitGroupMemberUpdated(group.id, {
          groupId: group.id,
          userId,
          action: 'joined',
        });
        return this.joinResponse(refreshed!, 'active');
      }
    }

    // ── New member ────────────────────────────────────────────────────────
    // MEM-004: approval mode → create a PENDING request (not active). #2: store
    // the chosen per-group display role (validated by the DTO).
    const status = approvalRequired ? 'pending' : 'active';
    await this.membersRepo.createMembership({
      groupId: group.id,
      userId,
      status,
      functionalRole: dto.functionalRole ?? null,
    });

    this.audit.log({
      organizationId: group.organizationId,
      actorId: userId,
      targetId: group.id,
      targetType: 'Group',
      action: 'join',
      metadata: { pending: approvalRequired },
      requestId,
    });

    if (approvalRequired) {
      // MEM-004/NTF-001: waiting for approval — alert admins, do NOT sync org
      // or emit a member-joined event until the request is approved.
      const requester = await this.usersRepo.findById(userId);
      this.alertAdminsJoinRequest(
        group.organizationId,
        userId,
        requester?.name ?? 'A member',
        group.name,
      );
      this.logger.log(`User ${userId} requested to join group ${group.id} (pending)`);
      return this.joinResponse(group, 'pending');
    }

    // Immediate join (no approval). Sync org + emit realtime membership change.
    await this.syncUserOrganization(userId, group.organizationId);
    this.logger.log(`User ${userId} joined group ${group.id}`);
    this.realtime?.emitGroupMemberUpdated(group.id, {
      groupId: group.id,
      userId,
      action: 'joined',
    });

    const refreshed = await this.groupsRepo.findById(group.id, group.organizationId);
    return this.joinResponse(refreshed!, 'active');
  }

  /**
   * MEM-004: join response — the serialized group plus `joinStatus` so the
   * client knows whether the member is now active or awaiting approval. Additive
   * key on the group JSON (old clients ignore it).
   */
  private joinResponse(group: GroupEntity, joinStatus: 'active' | 'pending') {
    return { ...GroupSerializer.toResponse(group), joinStatus };
  }

  // ── JOIN APPROVAL WORKFLOW (MEM-002..010, NTF-001/002/004) ─────────────────

  /**
   * MEM-002: pre-join preview by join code. Returns the identity + capacity +
   * approval info the client shows BEFORE joining. No membership change; safe to
   * call unauthenticated-of-org (the join code is the capability).
   */
  async previewByJoinCode(userId: string, joinCode: string) {
    const group = await this.groupsRepo.findByJoinCode(joinCode);
    if (!group || !group.isActive) {
      throw new BadRequestException({
        message: 'Invalid join code',
        errors: { joinCode: 'No active group found with this join code' },
      });
    }
    const expired =
      !!group.joinTokenExpiresAt && group.joinTokenExpiresAt < new Date();
    const names = await this.groupsRepo.getDetailNames(
      group.adminId,
      group.organizationId,
    );
    const membership = await this.membersRepo.findMembership(group.id, userId);
    const occupied = group.memberCount + group.pendingCount;
    return {
      groupId: group.id,
      organizationId: group.organizationId,
      organizationName: names.organizationName,
      name: group.name,
      description: group.description ?? null,
      type: group.type === 'factory' ? 'factory_' : group.type,
      currentMembers: group.memberCount,
      maxMembers: group.maxMembers ?? null,
      approvalRequired: group.joinApprovalRequired === true,
      isFull: group.maxMembers !== null && occupied >= group.maxMembers,
      expired,
      // Where the requester already stands with this group (null = not a member).
      myStatus: membership?.status ?? null,
    };
  }

  /**
   * MEM-006: admin approves a pending join request → member becomes active.
   * Re-validates capacity against ACTIVE members (a spot must be free).
   */
  async approveJoinRequest(
    groupId: string,
    targetUserId: string,
    organizationId: string,
    actorId: string,
    requestId?: string,
  ) {
    const group = await this.groupsRepo.findById(groupId, organizationId);
    if (!group) throw new NotFoundException('Group not found');

    const membership = await this.membersRepo.findMembership(groupId, targetUserId);
    if (!membership || membership.status !== 'pending') {
      throw new NotFoundException({
        message: 'No pending join request',
        errors: { memberId: 'This user has no pending join request for this group' },
      });
    }

    // MEM-008: capacity re-checked at approval time against active members.
    if (group.maxMembers !== null && group.memberCount >= group.maxMembers) {
      throw new ConflictException({
        message: 'Group Full – Contact Administrator',
        code: 'GROUP_FULL',
        errors: { memberId: 'This group has reached its maximum capacity' },
      });
    }

    const updated = await this.membersRepo.updateMembership(groupId, targetUserId, {
      status: 'active',
      reviewedBy: actorId,
      reviewedAt: new Date(),
      reviewNote: null as any,
    });

    await this.syncUserOrganization(targetUserId, organizationId);

    this.audit.log({
      organizationId,
      actorId,
      targetId: targetUserId,
      targetType: 'User',
      action: 'join',
      metadata: { groupId, approvedJoin: true },
      requestId,
    });

    this.realtime?.emitGroupMemberUpdated(groupId, {
      groupId,
      userId: targetUserId,
      action: 'joined',
    });

    // NTF-002: notify the member their request was approved.
    this.alertMember({
      organizationId,
      actorId,
      targetUserId,
      groupName: group.name,
      title: 'Join request approved',
      body: `You are now a member of ${group.name}.`,
      linkType: 'myGroups',
      push: 'joined',
    });

    return GroupMemberSerializer.toResponse(updated);
  }

  /**
   * MEM-007: admin rejects a pending join request (optional reason). The pending
   * row is removed so capacity frees and the member may request again later
   * (MEM-021). The decision is audited and pushed to the member's bell.
   */
  async rejectJoinRequest(
    groupId: string,
    targetUserId: string,
    organizationId: string,
    actorId: string,
    reason?: string,
    requestId?: string,
  ) {
    const group = await this.groupsRepo.findById(groupId, organizationId);
    if (!group) throw new NotFoundException('Group not found');

    const membership = await this.membersRepo.findMembership(groupId, targetUserId);
    if (!membership || membership.status !== 'pending') {
      throw new NotFoundException({
        message: 'No pending join request',
        errors: { memberId: 'This user has no pending join request for this group' },
      });
    }

    await this.membersRepo.hardDelete(groupId, targetUserId);

    this.audit.log({
      organizationId,
      actorId,
      targetId: targetUserId,
      targetType: 'User',
      action: 'update',
      metadata: { groupId, rejectedJoin: true, reason: reason ?? null },
      requestId,
    });

    // NTF-002: notify the member their request was rejected (with reason).
    this.alertMember({
      organizationId,
      actorId,
      targetUserId,
      groupName: group.name,
      title: 'Join request declined',
      body: reason
        ? `Your request to join ${group.name} was declined: ${reason}`
        : `Your request to join ${group.name} was declined.`,
      linkType: 'myGroups',
    });

    return { success: true, message: 'Join request rejected' };
  }

  /**
   * MEM-005: a member cancels their OWN pending join request before an admin
   * acts on it. Self-service — no admin role required.
   */
  async cancelJoinRequest(groupId: string, userId: string, requestId?: string) {
    const membership = await this.membersRepo.findMembership(groupId, userId);
    if (!membership || membership.status !== 'pending') {
      throw new NotFoundException({
        message: 'No pending join request',
        errors: { group: 'You have no pending join request for this group' },
      });
    }

    // Derive the org from the group (a pending member may not have org synced).
    const grp = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { organizationId: true },
    });

    await this.membersRepo.hardDelete(groupId, userId);

    if (grp?.organizationId) {
      this.audit.log({
        organizationId: grp.organizationId,
        actorId: userId,
        targetId: groupId,
        targetType: 'Group',
        action: 'update',
        metadata: { cancelledJoinRequest: true },
        requestId,
      });
    }

    return { success: true, message: 'Join request cancelled' };
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
    // GRP-013 / CFG-014: explicit hours win; otherwise re-apply the group's
    // configured QR expiry policy (days). No policy → Never expires.
    let expiresAt: Date | null = null;
    if (expiresInHours && expiresInHours > 0) {
      expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    } else if (existing.qrExpiryDays && existing.qrExpiryDays > 0) {
      expiresAt = new Date(
        Date.now() + existing.qrExpiryDays * 24 * 60 * 60 * 1000,
      );
    }

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

    // NTF-003 / MEM-022 (PRIORITY-1): mirror block/unblock/remove into the
    // member's notification bell (+ best-effort push). Best-effort — never
    // affects the membership write above.
    if (dto.status === 'blocked') {
      this.alertMember({
        organizationId,
        actorId,
        targetUserId,
        groupName: group.name,
        title: 'Access blocked',
        body: `An administrator has blocked your access to ${group.name}.`,
        linkType: 'myGroups',
        push: 'blocked',
      });
    } else if (dto.status === 'active' && membership.status === 'blocked') {
      // Unblock (was blocked → active). A plain role change is not a member
      // alert.
      this.alertMember({
        organizationId,
        actorId,
        targetUserId,
        groupName: group.name,
        title: 'Access restored',
        body: `Your access to ${group.name} has been restored.`,
        linkType: 'myGroups',
        push: 'joined',
      });
    } else if (dto.status === 'removed') {
      this.alertMember({
        organizationId,
        actorId,
        targetUserId,
        groupName: group.name,
        title: 'Removed from group',
        body: `You have been removed from ${group.name}.`,
        linkType: 'myGroups',
        push: 'removed',
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

    // NTF-003 / MEM-022: notify the removed member (bell + push).
    this.alertMember({
      organizationId,
      actorId,
      targetUserId,
      groupName: group.name,
      title: 'Removed from group',
      body: `You have been removed from ${group.name}.`,
      linkType: 'myGroups',
      push: 'removed',
    });

    return { message: 'Member removed from group', userId: targetUserId };
  }

  /**
   * MEM-016/017: a member voluntarily LEAVES a group (self-service). Sets
   * status='removed' (soft), preserving history for billing/audit. The client
   * switches to the next available group (MEM-017). Any authenticated member —
   * no admin role required.
   */
  async leaveGroup(groupId: string, userId: string, requestId?: string) {
    const membership = await this.membersRepo.findMembership(groupId, userId);
    if (!membership || membership.status === 'removed') {
      throw new NotFoundException({
        message: 'Not a member',
        errors: { group: 'You are not a member of this group' },
      });
    }

    // A pending request is cancelled, not "left" (MEM-005 semantics).
    if (membership.status === 'pending') {
      return this.cancelJoinRequest(groupId, userId, requestId);
    }

    const grp = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { organizationId: true, name: true },
    });

    await this.membersRepo.updateMembership(groupId, userId, {
      status: 'removed',
      removedAt: new Date(),
      removedBy: userId, // self
    });

    if (grp?.organizationId) {
      this.audit.log({
        organizationId: grp.organizationId,
        actorId: userId,
        targetId: groupId,
        targetType: 'Group',
        action: 'leave',
        metadata: { groupId, self: true },
        requestId,
      });
    }

    this.realtime?.emitGroupMemberUpdated(groupId, {
      groupId,
      userId,
      action: 'removed',
    });

    return { message: 'You have left the group', groupId };
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
      // NTF-003 / MEM-018: notify the reinvited member (bell + push).
      this.alertMember({
        organizationId,
        actorId,
        targetUserId,
        groupName: group.name,
        title: 'Added to a group',
        body: `An administrator added you to ${group.name}.`,
        linkType: 'myGroups',
        push: 'joined',
      });
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

    // NTF-003 / MEM-018: notify the added member (bell + push).
    this.alertMember({
      organizationId,
      actorId,
      targetUserId,
      groupName: group.name,
      title: 'Added to a group',
      body: `An administrator added you to ${group.name}.`,
      linkType: 'myGroups',
      push: 'joined',
    });

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
    // CFG-015: fixed, configurable Join Code length (default 8).
    const length = this.groupsCfg<number>('joinCodeLength', 8);
    const code = generateJoinCode(length);
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
    // GRP-012: qrPayload is now a SIGNED payload (org+group+token+expiry+sig).
    // joinCode stays the raw fixed-length code for manual entry (backward
    // compatible — the join endpoint accepts both).
    const secret = this.groupsCfg<string>('qrSigningSecret', 'emeal-qr-dev-secret');
    const qrPayload = encodeQrPayload(
      {
        o: group.organizationId,
        g: group.id,
        t: group.joinToken,
        e: group.joinTokenExpiresAt
          ? group.joinTokenExpiresAt.toISOString()
          : null,
      },
      secret,
    );
    return {
      groupId: group.id,
      joinCode: group.joinToken, // raw code for manual entry
      qrPayload, // Flutter renders the QR from this signed value
      expiresAt: group.joinTokenExpiresAt
        ? group.joinTokenExpiresAt.toISOString()
        : null,
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
      // Pass 11 (FR-VACX-001) + Pass 12 (FR-BILLX-020).
      vacationRequiresApproval: (group as any).vacationRequiresApproval ?? false,
      billingCycleStartDay: (group as any).billingCycleStartDay ?? null,
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
