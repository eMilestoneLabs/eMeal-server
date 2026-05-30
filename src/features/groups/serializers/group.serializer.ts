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
 *   "joinCode": "ABC12345",          ← DB: joinToken → API: joinCode (M-06)
 *   "memberCount": 45,               ← computed
 *   "memberIds": ["uuid1", "uuid2"], ← computed from active members
 *   "blockedMemberIds": ["uuid3"],   ← computed from blocked members
 *   "mealConfig": {                  ← ALWAYS nested (M-07)
 *     "mealsEnabled": true,
 *     "weeklyMenuEnabled": true,
 *     "preferencesEnabled": true,
 *     "enabledPreferences": ["veg","chicken","egg"],
 *     "vacationModeEnabled": true
 *   },
 *   "createdAt": "2026-01-01T00:00:00.000Z"
 * }
 *
 * NEVER:
 *   - expose joinToken instead of joinCode
 *   - flatten mealConfig fields to root level
 *   - rename any field
 *   - skip mealConfig even when meals are disabled
 */
export class GroupSerializer {
  static toResponse(group: GroupEntity): Record<string, unknown> {
    return {
      id: group.id,
      organizationId: group.organizationId,
      name: group.name,
      type: group.type,
      description: group.description ?? null,
      adminId: group.adminId ?? null,
      isActive: group.isActive,

      // M-06 fix: joinToken (DB column) → joinCode (API field)
      joinCode: group.joinToken,

      // Computed membership metrics
      memberCount: group.memberCount,
      memberIds: group.memberIds,
      blockedMemberIds: group.blockedMemberIds,

      // M-07 fix: always nested mealConfig object — never flattened
      mealConfig: {
        mealsEnabled: group.mealsEnabled,
        weeklyMenuEnabled: group.weeklyMenuEnabled,
        preferencesEnabled: group.preferencesEnabled,
        enabledPreferences: group.enabledPreferences,
        vacationModeEnabled: group.vacationModeEnabled,
      },

      createdAt: group.createdAt.toISOString(),
    };
  }
}
