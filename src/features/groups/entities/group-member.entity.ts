/**
 * GroupMember domain entity.
 * Represents a user's membership in a group with role and lifecycle status.
 */
export class GroupMemberEntity {
  id: string;
  groupId: string;
  userId: string;
  role: string;    // MemberRole: member | moderator | groupManager
  status: string;  // MemberStatus: active | pending | blocked | removed
  joinedAt: Date;
  updatedAt: Date;

  // Audit trail
  blockedAt: Date | null;
  blockedBy: string | null;  // userId of admin
  removedAt: Date | null;
  removedBy: string | null;  // userId of admin

  constructor(partial: Partial<GroupMemberEntity>) {
    Object.assign(this, partial);
    this.blockedAt = this.blockedAt ?? null;
    this.blockedBy = this.blockedBy ?? null;
    this.removedAt = this.removedAt ?? null;
    this.removedBy = this.removedBy ?? null;
  }
}
