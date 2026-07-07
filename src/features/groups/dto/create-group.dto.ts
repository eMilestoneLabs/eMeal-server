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
  MinLength,
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

  /**
   * SRS FR-VACX-001 (Pass 11): when ON, members must use a dated vacation
   * request (admin-approved) — the instant self-service toggle is disabled.
   */
  @IsOptional()
  @IsBoolean()
  vacationRequiresApproval?: boolean;

  /**
   * SRS FR-BILLX-020 (Pass 12): day-of-month the billing cycle starts (1–28).
   * Null/omitted = calendar month. Period math uses the org timezone.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  billingCycleStartDay?: number;

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
  // SRS GRP-003: Group Name is 2–50 characters (trimmed). MinLength runs after
  // the trim transform so whitespace can't pad a too-short name.
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  // BUG-002 contract: Flutter's GroupType.factory_ serializes as "factory_"
  // (Dart reserves `factory`), but the DB + VALID_GROUP_TYPES use "factory".
  // Normalize BEFORE @IsIn so the Factory type validates — mirrors
  // GroupSerializer.normalizeTypeForDb (which the service also applies). Without
  // this, creating a Factory group failed with a 422 "Validation failed".
  @Transform(({ value }) => (value === 'factory_' ? 'factory' : value))
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

  // ── Module 02 (GRP-003 / ORG-008) — extended metadata ──────────────────────
  // Captured at creation and immutable in the current release (the service
  // ignores these on update). All optional + length-bounded.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(80)
  country?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(80)
  state?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  /**
   * command_3 Issue 8: postal / PIN code, captured at creation (GRP-003 family).
   * Optional + length-bounded server-side (client enforces a 6-digit PIN for
   * India); additive so existing callers are unaffected.
   */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(16)
  pin?: string;

  /**
   * command_3 Issue 8: Address is now optional with a hard 30-char limit
   * (was 200). Older payloads over 30 chars are historical only — new writes
   * are bounded here.
   */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(30)
  address?: string;

  /** IANA timezone for the group display (null = inherit organization tz). */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  /** ISO 4217 currency code (e.g. INR). Upper-cased + length-bounded. */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  /** GRP-003 / MEM-004: enable admin approval for join requests. */
  @IsOptional()
  @IsBoolean()
  joinApprovalRequired?: boolean;

  /**
   * GRP-013 / CFG-014: QR/Join-Code expiry in days. Omitted or 0 = Never
   * expires. Bounded to a sane maximum (2 years).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(730)
  qrExpiryDays?: number;

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
