import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * GroupType enum values — EXACTLY matching Flutter GroupType enum (M-05 fix).
 * DO NOT add 'organization' or 'eventSystem' — they don't exist in Flutter.
 */
export const VALID_GROUP_TYPES = [
  'hostel',
  'mess',
  'cafeteria',
  'pg',
  'coachingInstitute',
  'office',
  'factory',
  'community',
  'event',
  'other',
] as const;

/**
 * Functional roles an admin may assign to a member FOR A SPECIFIC GROUP (#8).
 * Mirrors the Flutter UserRole enum exactly. Additive — never returned as an
 * enum column rename; stored on GroupMember.functionalRole (nullable).
 */
export const VALID_FUNCTIONAL_ROLES = [
  'student',
  'member',
  'guest',
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
  'eventAdmin',
  'eventGuest',
] as const;

/**
 * Module 22 (FR-HG-020/021) — per-group hosted-guest configuration.
 * Cross-field rules (perGuestPrice requires prices, etc.) are enforced in
 * GroupsService so partial PATCHes validate against the FINAL effective state.
 * Declared BEFORE MealConfigDto: the `guestConfig?: GuestConfigDto` property
 * emits design:type metadata at decoration time — a later declaration would
 * hit the class TDZ at module load.
 */
export class GuestConfigDto {
  @IsOptional()
  @IsBoolean()
  guestAttendanceEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  maxGuestsPerMemberPerMeal?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxGuestsPerMemberPerDay?: number;

  @IsOptional()
  @IsIn(['sameAsMember', 'flatSurcharge', 'perGuestPrice'])
  guestPricingMode?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  guestAdultPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  guestChildPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  guestSurcharge?: number;

  @IsOptional()
  @IsBoolean()
  guestRequiresApproval?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720)
  guestCutoffMinutesBeforeClose?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  guestAdvanceBookingDays?: number;

  @IsOptional()
  @IsBoolean()
  guestPreferenceRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  allowGuestWithoutHost?: boolean;

  @IsOptional()
  @IsBoolean()
  billNoShowGuests?: boolean;
}

export class MealConfigDto {
  @IsOptional()
  @IsBoolean()
  mealsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  weeklyMenuEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  dayWiseMealsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  preferencesEnabled?: boolean;

  /**
   * Allowed preference keys (lowercase).
   * Backend stores these — Flutter renders chips from this array.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledPreferences?: string[];

  @IsOptional()
  @IsBoolean()
  vacationModeEnabled?: boolean;

  /** Additive: when ON, meals carry a ₹ price (master + per-day). */
  @IsOptional()
  @IsBoolean()
  mealPricingEnabled?: boolean;

  /**
   * SRS FR-TIME-005 (LOOP-090): grace period in minutes that extends the
   * attendance-window close for late marking. 0 or null = no grace.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  attendanceGraceMinutes?: number;

  /**
   * SRS FR-TRUST-001 (Module 33): group trust model. 'absent' = opt-in
   * (legacy default — unmarked means not counted/billed); 'present' = opt-out
   * (unmarked members are auto-marked Present at window close, reversibly).
   */
  @IsOptional()
  @IsIn(['absent', 'present'])
  attendanceDefault?: string;

  /**
   * SRS FR-TRUST-003: fair-opportunity floor — minutes the window must have
   * been open for opt-out auto-billing to be valid. Null = server default.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  minOptOutMinutes?: number;

  /** Module 22 (Pass 8, FR-HG-020): hosted-guest configuration. */
  @IsOptional()
  @ValidateNested()
  @Type(() => GuestConfigDto)
  guestConfig?: GuestConfigDto;
}

export class CreateGroupDto {
  // Trimmed BEFORE validation — IsNotEmpty alone accepts whitespace-only
  // strings (FR-GRP-013, caught live in the Pass 10 server validation).
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsIn(VALID_GROUP_TYPES, {
    message: `type must be one of: ${VALID_GROUP_TYPES.join(', ')}`,
  })
  type: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxMembers?: number;

  /**
   * mealConfig — optional at creation, defaults applied by service.
   * Serializer always returns nested mealConfig regardless.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => MealConfigDto)
  mealConfig?: MealConfigDto;

  /**
   * Additive (#8): the creator's functional role FOR THIS GROUP.
   * Optional — when omitted the service falls back to the creator's global role.
   */
  @IsOptional()
  @IsIn(VALID_FUNCTIONAL_ROLES, {
    message: `functionalRole must be one of: ${VALID_FUNCTIONAL_ROLES.join(', ')}`,
  })
  functionalRole?: string;
}
