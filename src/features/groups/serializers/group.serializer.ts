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
        mealPricingEnabled: group.mealPricingEnabled,
      },

      createdAt: group.createdAt.toISOString(),
    };
  }
}
