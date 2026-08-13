import { UserEntity } from '../entities/user.entity';

/**
 * Serializer — converts domain entity to exact Flutter JSON contract shape.
 * Flutter contract verified from lib/shared/models/user_model.dart
 *
 * Field mapping notes:
 * - groupIds[] computed from GroupMember table
 * - groupId = first groupId (legacy compat)
 * - All boolean fields must be present (never undefined)
 * - createdAt as ISO string
 */
export class UserSerializer {
  static toResponse(user: UserEntity): Record<string, unknown> {
    return {
      id: user.id,
      name: user.name,
      email: user.email ?? null,
      phone: user.phone ?? null,
      role: user.role,
      organizationId: user.organizationId ?? null,
      groupId: user.groupId ?? null,
      groupIds: user.groupIds ?? [],
      // Live-Test-11 ISSUE-001 (additive): membership briefs {id, name, role}
      // so the client shows real group names in its switcher. Empty for
      // finders that don't join the Group relation — client falls back.
      groups: user.groups ?? [],
      avatarUrl: user.avatarUrl ?? null,
      gender: user.gender ?? null,
      age: user.age ?? null,
      isActive: user.isActive,
      isVacationMode: user.isVacationMode,
      isDefaultAttendance: user.isDefaultAttendance,
      // Additive: the groups the vacation flag above actually applies to.
      // `null` (every path except GET /users/me) means "governs every group" —
      // exactly the behaviour every existing client already implements, so an
      // older client ignoring this field is unchanged.
      vacationScopedGroupIds: user.vacationScopedGroupIds ?? null,
      remindersEnabled: user.remindersEnabled,
      loginPreference: user.loginPreference ?? 'email',
      // SRS AUTH-036/040/041 — lets the client gate onboarding on email verification.
      emailVerified: !!user.emailVerifiedAt,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
