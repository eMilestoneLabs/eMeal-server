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
  remindersEnabled: boolean;
  loginPreference: string | null;
  fcmToken: string | null;

  // Computed from GroupMember table — not a DB column
  groupId: string | null;
  groupIds: string[];

  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<UserEntity>) {
    Object.assign(this, partial);
    this.groupIds = this.groupIds ?? [];
    this.groupId = this.groupId ?? this.groupIds[0] ?? null;
  }
}
