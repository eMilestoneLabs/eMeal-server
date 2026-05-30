import { GroupMemberEntity } from '../entities/group-member.entity';

/**
 * GroupMemberSerializer — member record response shape.
 * Additive-safe: only add fields, never remove or rename.
 */
export class GroupMemberSerializer {
  static toResponse(member: GroupMemberEntity): Record<string, unknown> {
    return {
      id: member.id,
      groupId: member.groupId,
      userId: member.userId,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt.toISOString(),
      updatedAt: member.updatedAt.toISOString(),
      blockedAt: member.blockedAt?.toISOString() ?? null,
      blockedBy: member.blockedBy ?? null,
      removedAt: member.removedAt?.toISOString() ?? null,
    };
  }
}
