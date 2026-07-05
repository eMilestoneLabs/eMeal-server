/**
 * ScheduleEntryEntity — domain model for a single day+meal assignment in a schedule.
 *
 * Serializer maps:
 *   dayOfWeek Int (0=Mon...6=Sun) → day string ("monday"..."sunday")
 *   meal.slotKey                  → slotKey (joined from Meal relation)
 *   mealName ?? meal.name         → mealName
 *   date DateTime                 → date string "YYYY-MM-DD"
 */
export class ScheduleEntryEntity {
  id: string;
  scheduleId: string;
  mealId: string;

  // 0=Monday, 1=Tuesday, ..., 6=Sunday
  // Serializer converts to "monday", "tuesday", ..., "sunday"
  dayOfWeek: number;

  // Specific date (UTC midnight)
  date: Date;

  // Per-day timing overrides (null = use meal template's attendanceWindow)
  openTime: string | null;
  closeTime: string | null;

  // What's being served on this day (e.g. "Poha", "Dal Rice")
  mealName: string | null;

  // Optional notes shown to students (e.g. "Extra fruits today")
  notes: string | null;

  // Additive: per-day meal description override (null = inherit master meal description).
  description: string | null;

  // Additive: per-day meal image override (null = inherit master meal image).
  imageUrl: string | null;

  // Per-day meal preference override (#6). null = inherit from the meal.
  preferencesEnabled: boolean | null;
  enabledPreferences: string[];
  // Additive (#3): per-day subset of the meal's master preference group IDs that
  // apply this day. Empty = inherit ALL master groups (unchanged behaviour).
  enabledPreferenceGroupIds: string[];
  menuItems: string[];
  // Additive: per-day ₹ price override (null = inherit master meal price).
  price: number | null;

  // Populated from Meal join — required for days[].meals[] serialization (M-12)
  meal?: {
    slotKey: string;
    name: string;
    displayName: string | null;
    order: number;
    menuItems: string[];
    imageUrl: string | null;
    description: string | null;
    price: number | null;
    // FR-MEAL-007: template window used for chronological within-day ordering
    // when the entry has no per-day override. Optional — snapshots published
    // before this field existed simply fall back to `order`.
    attendanceWindowOpen?: string | null;
    attendanceWindowClose?: string | null;
  };

  constructor(partial: Partial<ScheduleEntryEntity> & Pick<ScheduleEntryEntity, 'id' | 'scheduleId' | 'mealId' | 'dayOfWeek' | 'date'>) {
    this.id = partial.id;
    this.scheduleId = partial.scheduleId;
    this.mealId = partial.mealId;
    this.dayOfWeek = partial.dayOfWeek;
    this.date = partial.date;
    this.openTime = partial.openTime ?? null;
    this.closeTime = partial.closeTime ?? null;
    this.mealName = partial.mealName ?? null;
    this.notes = partial.notes ?? null;
    this.description = partial.description ?? null;
    this.imageUrl = partial.imageUrl ?? null;
    this.preferencesEnabled = partial.preferencesEnabled ?? null;
    this.enabledPreferences = partial.enabledPreferences ?? [];
    this.enabledPreferenceGroupIds = partial.enabledPreferenceGroupIds ?? [];
    this.menuItems = partial.menuItems ?? [];
    this.price = partial.price ?? null;
    this.meal = partial.meal;
  }
}

/**
 * MealScheduleEntity — domain model for a weekly schedule.
 *
 * Serializer maps:
 *   weekStart DateTime → weekStartDate "YYYY-MM-DD" (date-only string)
 *   entries             → nested entry array with full slot info
 */
export class MealScheduleEntity {
  id: string;
  organizationId: string;
  groupId: string;

  // Monday of the scheduled week (UTC midnight)
  // Serialized as "weekStartDate": "YYYY-MM-DD"
  weekStart: Date;

  isPublished: boolean;
  publishedAt: Date | null;

  entries: ScheduleEntryEntity[];

  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<MealScheduleEntity> & Pick<MealScheduleEntity, 'id' | 'organizationId' | 'groupId' | 'weekStart'>) {
    this.id = partial.id;
    this.organizationId = partial.organizationId;
    this.groupId = partial.groupId;
    this.weekStart = partial.weekStart;
    this.isPublished = partial.isPublished ?? false;
    this.publishedAt = partial.publishedAt ?? null;
    this.entries = partial.entries ?? [];
    this.createdAt = partial.createdAt ?? new Date();
    this.updatedAt = partial.updatedAt ?? new Date();
  }
}
