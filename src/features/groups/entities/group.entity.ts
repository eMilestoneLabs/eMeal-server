/**
 * Group domain entity.
 * Includes computed fields (memberCount, memberIds, blockedMemberIds)
 * derived from GroupMember table at query time — not stored as columns.
 *
 * Serializer maps:
 *   joinToken  → joinCode    (M-06 fix: DB internal name vs API key)
 *   flat cols  → mealConfig  (M-07 fix: nested in API, flat in DB)
 */
export class GroupEntity {
  id: string;
  organizationId: string;
  name: string;
  type: string;            // GroupType enum value — kept as string for flexibility
  description: string | null;
  adminId: string | null;

  // Join code — exposed as "joinCode" in API (joinToken in DB)
  joinToken: string;
  joinTokenExpiresAt: Date | null;

  maxMembers: number | null;
  isActive: boolean;

  // ── mealConfig flat columns — serialized as nested object ────────────────
  mealsEnabled: boolean;
  weeklyMenuEnabled: boolean;
  preferencesEnabled: boolean;
  enabledPreferences: string[];
  vacationModeEnabled: boolean;

  // ── Computed from GroupMember at query time ───────────────────────────────
  memberCount: number;
  memberIds: string[];
  blockedMemberIds: string[];

  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<GroupEntity>) {
    Object.assign(this, partial);
    // Computed fields default to empty
    this.memberCount = this.memberCount ?? 0;
    this.memberIds = this.memberIds ?? [];
    this.blockedMemberIds = this.blockedMemberIds ?? [];
    this.enabledPreferences = this.enabledPreferences ?? [];
    this.description = this.description ?? null;
    this.adminId = this.adminId ?? null;
    this.maxMembers = this.maxMembers ?? null;
    this.joinTokenExpiresAt = this.joinTokenExpiresAt ?? null;
  }
}
