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
      maxMembers: group.maxMembers ?? null,

      // Additive (#8): requester's per-group functional role (null = use global).
      functionalRole: group.functionalRole ?? null,

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
        mealPricingEnabled: group.mealPricingEnabled,
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
