import { GroupMemberEntity } from '../entities/group-member.entity';
import { resolveMemberFlag } from '../../../common/utils/member-settings.util';

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
      // additive (#8): per-group functional title (null -> client uses global role)
      functionalRole: member.functionalRole ?? null,
      status: member.status,
      joinedAt: member.joinedAt.toISOString(),
      updatedAt: member.updatedAt.toISOString(),
      blockedAt: member.blockedAt?.toISOString() ?? null,
      blockedBy: member.blockedBy ?? null,
      removedAt: member.removedAt?.toISOString() ?? null,
      // B10 (ADDITIVE — never remove): joined user profile for member lists.
      // Flutter maps this to UserModel; legacy consumers ignore the extra key.
      // emailVerifiedAt (Date) is exposed as emailVerified (bool) for the badge.
      user: member.user
        ? (() => {
            const { emailVerifiedAt, ...rest } = member.user as typeof member.user & {
              emailVerifiedAt?: Date | null;
            };
            return {
              ...rest,
              emailVerified: !!emailVerifiedAt,
              // Same key, same type — but this response IS a group's roster, so
              // the value must be THIS group's effective vacation state. The
              // raw user flag would badge a member "on vacation" here because
              // they are on vacation in a DIFFERENT group. Resolved from the
              // membership row the list query already returns: no extra query,
              // no response-shape change.
              isVacationMode: resolveMemberFlag(
                member,
                member.user,
                'isVacationMode',
              ),
            };
          })()
        : null,
    };
  }
}
