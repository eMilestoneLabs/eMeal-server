import { UserRole } from '@prisma/client';

/**
 * Domain entity — sits between Prisma model and API DTO.
 * Includes computed fields (groupIds) that don't exist as single DB columns.
 */
export class UserEntity {
  id: string;
  organizationId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  gender: string | null;
  age: number | null;
  avatarUrl: string | null;

  // Operational fields (M-08, M-09 fixes)
  isActive: boolean;
  isVacationMode: boolean;
  isDefaultAttendance: boolean;

  // Which groups the CURRENT vacation actually applies to. Additive, resolved
  // per-request on the GET /users/me path only — not a DB column.
  //   null      → the flag governs every group (pure toggle, or an ORG-LEVEL
  //               covering request). This is the value on every other path,
  //               so nothing that does not populate it changes behaviour.
  //   string[]  → only these groups; the member is NOT on vacation elsewhere.
  // See resolveVacationScopeGroupIds for why the client needs this to avoid
  // showing "on vacation" in a group the leave was never requested for.
  vacationScopedGroupIds?: string[] | null;
  remindersEnabled: boolean;
  loginPreference: string | null;
  fcmToken: string | null;
  emailVerifiedAt: Date | null; // SRS AUTH-036/040 — null = email not yet verified

  // Computed from GroupMember table — not a DB column
  groupId: string | null;
  groupIds: string[];

  // Live-Test-11 ISSUE-001 (additive): per-membership brief so the client can
  // label its group switcher with real names + per-group functional roles.
  // Optional — only populated by finders that join the Group relation.
  groups?: { id: string; name: string; role: string | null }[];

  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<UserEntity>) {
    Object.assign(this, partial);
    this.groupIds = this.groupIds ?? [];
    this.groupId = this.groupId ?? this.groupIds[0] ?? null;
  }
}
