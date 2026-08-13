/**
 * GroupMember domain entity.
 * Represents a user's membership in a group with role and lifecycle status.
 */
export class GroupMemberEntity {
  id: string;
  groupId: string;
  userId: string;
  role: string;    // MemberRole: member | moderator | groupManager
  functionalRole: string | null; // additive (#8): per-group UserRole-style title; null -> fall back to User.role
  status: string;  // MemberStatus: active | pending | blocked | removed
  joinedAt: Date;
  updatedAt: Date;

  // Audit trail
  blockedAt: Date | null;
  blockedBy: string | null;  // userId of admin
  removedAt: Date | null;
  removedBy: string | null;  // userId of admin

  // Per-group member settings. NULL means "inherit the user-level flag" — it
  // is NOT the same as false, so these are never defaulted to a boolean here.
  // Resolve with resolveMemberFlag(member, user, key); never read them raw.
  //
  // These two columns are never emitted as response fields of their own:
  // GroupMemberSerializer reads them only to resolve the EFFECTIVE value it
  // already returns under `user.isVacationMode`, so the member-list response
  // shape stays exactly as it was.
  isVacationMode: boolean | null;
  isDefaultAttendance: boolean | null;

  // B10 (additive): joined user profile for the member directory UI.
  // Populated only by the paginated member-list query; null elsewhere.
  user: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    avatarUrl: string | null;
    gender: string | null;
    age: number | null;
    role: string;
    isVacationMode: boolean;
    emailVerifiedAt?: Date | null; // SRS AUTH-036/040 — serialized as `emailVerified`
  } | null;

  constructor(partial: Partial<GroupMemberEntity>) {
    Object.assign(this, partial);
    this.functionalRole = this.functionalRole ?? null;
    this.blockedAt = this.blockedAt ?? null;
    this.blockedBy = this.blockedBy ?? null;
    this.removedAt = this.removedAt ?? null;
    this.removedBy = this.removedBy ?? null;
    this.isVacationMode = this.isVacationMode ?? null;
    this.isDefaultAttendance = this.isDefaultAttendance ?? null;
    this.user = this.user ?? null;
  }
}
