import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  @IsIn(['veg', 'chicken', 'fish', 'mutton', 'egg', 'jain'], { each: true })
  enabledPreferences?: string[];

  @IsOptional()
  @IsBoolean()
  vacationModeEnabled?: boolean;
}

export class CreateGroupDto {
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
