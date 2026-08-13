import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'phone must be a valid mobile number' })
  phone?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['male', 'female', 'other', 'prefer_not_to_say'])
  gender?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  age?: number;

  @IsOptional()
  @IsBoolean()
  isVacationMode?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefaultAttendance?: boolean;

  @IsOptional()
  @IsBoolean()
  remindersEnabled?: boolean;

  @IsOptional()
  @IsIn(['email', 'mobile'])
  loginPreference?: 'email' | 'mobile';
}

export class VacationModeDto {
  @IsBoolean()
  enabled: boolean;

  /**
   * Additive + OPTIONAL: scope Return Early to ONE group.
   *
   * Omitted (every existing client, including shipped APKs) behaves exactly as
   * before — the org-wide toggle. Supplied, only this group's vacation ends,
   * so a member in several groups no longer truncates a separately-approved
   * vacation elsewhere. Never trusted: validated against the target user's
   * ACTIVE membership inside the caller's organization before any write.
   */
  @IsOptional()
  @IsString()
  // An EMPTY string is a client bug, not "no scope": `if (groupId)` treats it
  // as falsy, so it would silently take the ORG-WIDE path and write every
  // group the member belongs to — the exact spill this feature removes, and
  // silently, which is the worst failure direction. Rejecting it keeps
  // "omitted = org-wide" as the only way to reach that path.
  @IsNotEmpty()
  groupId?: string;
}

export class DefaultAttendanceDto {
  @IsBoolean()
  enabled: boolean;

  /**
   * Additive + OPTIONAL: scope Personal Auto-Attendance to ONE group.
   *
   * Omitted keeps the historical user-level write (all groups). Supplied, only
   * this membership is set, so a member can auto-mark in one group and not
   * another. Same validation rule as {@link VacationModeDto.groupId}.
   */
  @IsOptional()
  @IsString()
  // Same rule as {@link VacationModeDto.groupId}: empty is a client bug, and
  // silently falling back to the org-wide write is the one outcome this
  // feature must never produce.
  @IsNotEmpty()
  groupId?: string;
}
