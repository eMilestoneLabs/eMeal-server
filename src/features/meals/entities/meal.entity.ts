/**
 * MealEntity — domain model for a Meal slot.
 *
 * Prisma model → Domain layer (never exposed directly).
 *
 * Key serialization mappings (MealSerializer responsibility):
 *   DB: name            → API: name (internal)
 *   DB: displayName     → API: displayName (falls back to name if null)
 *   DB: isActive        → API: isEnabled
 *   DB: enabledPrefs    → API: preferences
 *   DB: attendanceWindowOpen/Close → API: attendanceWindow: { openTime, closeTime }
 *
 * slotKey is always free-form string — NEVER an enum.
 */
export class MealEntity {
  id: string;
  organizationId: string;
  groupId: string;

  // Slot identity
  slotKey: string;     // free-form: "breakfast","lunch","dinner","iftar","sehri"
  name: string;        // internal admin-facing label
  displayName: string | null; // student-facing label; serialized with fallback to name

  order: number;

  // Content
  description: string | null;
  menuItems: string[];
  imageUrl: string | null;

  // Visibility
  isActive: boolean;          // serialized as "isEnabled" (M-04 pattern)
  attendanceEnabled: boolean; // independently controls attendance marking

  // Preferences
  preferencesEnabled: boolean;
  enabledPreferences: string[]; // serialized as "preferences" in API

  // Attendance window — flat storage, nested serialization
  attendanceWindowOpen: string | null;  // "HH:mm"
  attendanceWindowClose: string | null; // "HH:mm"

  // Additive: ₹ price (integer). Null when pricing disabled/unset.
  price: number | null;

  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<MealEntity> & Pick<MealEntity, 'id' | 'organizationId' | 'groupId' | 'slotKey' | 'name'>) {
    this.id = partial.id;
    this.organizationId = partial.organizationId;
    this.groupId = partial.groupId;
    this.slotKey = partial.slotKey;
    this.name = partial.name;
    this.displayName = partial.displayName ?? null;
    this.order = partial.order ?? 0;
    this.description = partial.description ?? null;
    this.menuItems = partial.menuItems ?? [];
    this.imageUrl = partial.imageUrl ?? null;
    this.isActive = partial.isActive ?? true;
    this.attendanceEnabled = partial.attendanceEnabled ?? true;
    this.preferencesEnabled = partial.preferencesEnabled ?? false;
    this.enabledPreferences = partial.enabledPreferences ?? [];
    this.attendanceWindowOpen = partial.attendanceWindowOpen ?? null;
    this.attendanceWindowClose = partial.attendanceWindowClose ?? null;
    this.price = partial.price ?? null;
    this.createdAt = partial.createdAt ?? new Date();
    this.updatedAt = partial.updatedAt ?? new Date();
  }
}
