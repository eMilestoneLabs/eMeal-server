import { MealEntity } from '../entities/meal.entity';

/**
 * MealSerializer — converts MealEntity to exact Flutter JSON contract.
 *
 * CONTRACT (from lib/shared/models/meal_model.dart — LOCKED):
 * {
 *   "id": "uuid",
 *   "groupId": "uuid",
 *   "organizationId": "uuid",
 *   "name": "Breakfast",              ← Flutter reads json['name']
 *   "slotKey": "breakfast",           ← free-form string, NEVER enum
 *   "order": 1,
 *   "isActive": true,                 ← Flutter reads json['isActive']
 *   "attendanceEnabled": true,
 *   "preferencesEnabled": true,
 *   "enabledPreferences": ["veg","egg"], ← Flutter reads json['enabledPreferences']
 *   "description": null,
 *   "menuItems": [],
 *   "imageUrl": null,
 *   "attendanceWindow": {             ← M-04: ALWAYS nested (never flat)
 *     "openTime": "07:00",
 *     "closeTime": "09:00"
 *   },
 *   "createdAt": "2026-01-01T00:00:00.000Z"
 * }
 *
 * NEVER:
 *   - rename isActive to isEnabled (Flutter reads isActive)
 *   - rename enabledPreferences to preferences (Flutter reads enabledPreferences)
 *   - rename name to displayName (Flutter reads name)
 *   - flatten attendanceWindow fields to root level
 *   - hardcode any slotKey values
 */
export class MealSerializer {
  static toResponse(meal: MealEntity): Record<string, unknown> {
    return {
      id: meal.id,
      groupId: meal.groupId,
      organizationId: meal.organizationId ?? null,

      // Flutter reads json['name'] — use displayName as override if set
      name: meal.displayName ?? meal.name,

      // Dynamic slot — free-form, admin-configurable
      slotKey: meal.slotKey,
      order: meal.order,

      // Flutter reads json['isActive']
      isActive: meal.isActive,

      attendanceEnabled: meal.attendanceEnabled,
      preferencesEnabled: meal.preferencesEnabled,

      // Flutter reads json['enabledPreferences']
      enabledPreferences: meal.enabledPreferences,

      description: meal.description,
      menuItems: meal.menuItems,
      imageUrl: meal.imageUrl,

      // M-04 fix: attendanceWindow ALWAYS nested — null if both fields are null
      attendanceWindow: meal.attendanceWindowOpen != null
        ? {
            openTime: meal.attendanceWindowOpen,
            closeTime: meal.attendanceWindowClose,
          }
        : null,

      createdAt: meal.createdAt.toISOString(),
    };
  }

  static toList(meals: MealEntity[]): Record<string, unknown>[] {
    return meals.map((m) => MealSerializer.toResponse(m));
  }
}
