import { GroupEntity } from '../entities/group.entity';

/**
 * GroupSerializer — converts domain entity to exact Flutter JSON contract.
 *
 * CONTRACT (from lib/shared/models/group_model.dart — LOCKED):
 * {
 *   "id": "uuid",
 *   "organizationId": "uuid",
 *   "name": "Boys Hostel Block A",
 *   "type": "hostel",
 *   "description": "Ground floor",
 *   "adminId": "uuid",
 *   "isActive": true,
 *   "joinCode": "ABC12345",
 *   "memberCount": 45,
 *   "memberIds": ["uuid1"],
 *   "blockedMemberIds": [],
 *   "maxMembers": 100,
 *   "mealConfig": { "mealsEnabled": true, ... },
 *   "createdAt": "ISO"
 * }
 *
 * BUG-002 FIX: Dart enum reserved word workaround.
 *   Flutter GroupType.factory_.name == "factory_" (with underscore)
 *   DB stores "factory" (without underscore)
 *   Serializer MUST map: "factory" → "factory_" on output
 *   DTO normalization MUST map: "factory_" → "factory" on input (see groups.service.ts)
 */
export class GroupSerializer {
  /**
   * Normalizes incoming type from Flutter: "factory_" → "factory" for DB storage.
   * Call this in service before creating/updating a group.
   */
  static normalizeTypeForDb(type: string): string {
    return type === 'factory_' ? 'factory' : type;
  }

  /**
   * Module 22 (FR-HG-020/022): hosted-guest config with server defaults
   * resolved, nested inside mealConfig (additive key — old clients ignore).
   */
  static guestConfig(group: Partial<GroupEntity>): Record<string, unknown> {
    return {
      guestAttendanceEnabled: group.guestAttendanceEnabled ?? false,
      maxGuestsPerMemberPerMeal: group.maxGuestsPerMemberPerMeal ?? 5,
      maxGuestsPerMemberPerDay: group.maxGuestsPerMemberPerDay ?? null,
      guestPricingMode: group.guestPricingMode ?? 'sameAsMember',
      guestAdultPrice: group.guestAdultPrice ?? null,
      guestChildPrice: group.guestChildPrice ?? null,
      guestSurcharge: group.guestSurcharge ?? null,
      // SRS Module 03 GST-011: surcharge method ('fixed' default preserves
      // pre-existing behaviour for groups configured before this field).
      guestSurchargeType: group.guestSurchargeType ?? 'fixed',
      guestRequiresApproval: group.guestRequiresApproval ?? false,
      guestCutoffMinutesBeforeClose: group.guestCutoffMinutesBeforeClose ?? 0,
      guestAdvanceBookingDays: group.guestAdvanceBookingDays ?? 0,
      guestPreferenceRequired: group.guestPreferenceRequired ?? false,
      allowGuestWithoutHost: group.allowGuestWithoutHost ?? false,
      billNoShowGuests: group.billNoShowGuests ?? true,
    };
  }

  static toResponse(group: GroupEntity): Record<string, unknown> {
    return {
      id: group.id,
      organizationId: group.organizationId,
      name: group.name,
      // BUG-002 FIX: map DB "factory" → Flutter "factory_"
      type: group.type === 'factory' ? 'factory_' : group.type,
      description: group.description ?? null,
      adminId: group.adminId ?? null,
      isActive: group.isActive,

      // M-06 fix: joinToken (DB column) → joinCode (API field)
      joinCode: group.joinToken,

      // Computed membership metrics
      memberCount: group.memberCount,
      memberIds: group.memberIds,
      blockedMemberIds: group.blockedMemberIds,
      // MEM-008/010 / CFG-009: pending join requests (approval mode).
      pendingCount: group.pendingCount ?? 0,
      pendingMemberIds: group.pendingMemberIds ?? [],
      maxMembers: group.maxMembers ?? null,

      // Module 02 (GRP-003 / ORG-008): extended metadata + policy. Additive
      // keys — older Flutter clients ignore unknown fields.
      country: group.country ?? null,
      state: group.state ?? null,
      city: group.city ?? null,
      pin: group.pin ?? null, // command_3 Issue 8 — postal/PIN code
      address: group.address ?? null,
      timezone: group.timezone ?? null,
      currency: group.currency ?? null,
      // GRP-003 / MEM-004: Join Approval Mode flag.
      joinApprovalRequired: group.joinApprovalRequired ?? false,
      // GRP-013 / CFG-014: QR expiry policy (days; null = Never) + concrete
      // deadline so the client can show "expires on".
      qrExpiryDays: group.qrExpiryDays ?? null,
      joinCodeExpiresAt: group.joinTokenExpiresAt
        ? group.joinTokenExpiresAt.toISOString()
        : null,
      // GRP-016: archive marker for the lifecycle UI.
      archivedAt: group.archivedAt ? group.archivedAt.toISOString() : null,

      // Additive (#8): requester's per-group functional role (null = use global).
      functionalRole: group.functionalRole ?? null,
      // Additive: the REQUESTER's own per-group setting overrides, populated
      // only on the detail read. `null` on a field means "inherit the
      // user-level flag", which the client already has in its session — so the
      // student Settings tab can show THIS group's true state with no extra
      // call. Never the whole member map: that would leak every member's state.
      myMemberSettings: group.myMemberSettings ?? null,

      // Additive (ISSUE 2): read-only detail context for members. Populated only
      // on GET /groups/:id (null elsewhere / when unavailable).
      adminName: group.adminName ?? null,
      organizationName: group.organizationName ?? null,

      // M-07 fix: always nested mealConfig object — never flattened
      mealConfig: {
        mealsEnabled: group.mealsEnabled,
        weeklyMenuEnabled: group.weeklyMenuEnabled,
        dayWiseMealsEnabled: group.dayWiseMealsEnabled,
        preferencesEnabled: group.preferencesEnabled,
        enabledPreferences: group.enabledPreferences,
        vacationModeEnabled: group.vacationModeEnabled,
        // Pass 11 (FR-VACX-001) + Pass 12 (FR-BILLX-020) — additive.
        vacationRequiresApproval: group.vacationRequiresApproval ?? false,
        billingCycleStartDay: group.billingCycleStartDay ?? null,
        // Additive: lets the client show the cycle-day control as permanently
        // locked once the one-time change has been used. Backend stays the
        // authority — this flag is display only.
        billingCycleChangeUsed: !!group.billingCycleChangedAt,
        mealPricingEnabled: group.mealPricingEnabled,
        // Live-Test-16 ISSUE-1 §9/§11: the Meal-Pricing ON/OFF mode is frozen
        // by the group's FIRST successful schedule publication. Display-only —
        // the backend stays the authority (updateGroup rejects a locked flip).
        mealPricingLocked: !!group.firstSchedulePublishedAt,
        // SRS Module 03 (survey Q17/Q22): Bill-Skip policy (default OFF).
        billSkippedMeals: group.billSkippedMeals ?? false,
        // Live-Test-11 ISSUE-017 (survey-locked): the independent Bill-Absent
        // toggle is BACK — default OFF for every group (null/false = free).
        // Completely independent from Bill-Skip; date-forward via the
        // per-record billAbsent snapshot taken at mark time.
        billAbsentMeals: group.billAbsentMeals === true,
        // SRS FR-TIME-005: per-group late-marking grace (minutes, 0 = none).
        attendanceGraceMinutes: group.attendanceGraceMinutes ?? 0,
        // SRS FR-TRUST-001/003: trust model ('absent' opt-in default) + floor.
        attendanceDefault: group.attendanceDefault ?? 'absent',
        minOptOutMinutes: group.minOptOutMinutes ?? null,
        // Module 22 (FR-HG-020/022): hosted-guest config, nested + additive.
        guestConfig: GroupSerializer.guestConfig(group),
      },

      createdAt: group.createdAt.toISOString(),
    };
  }
}
