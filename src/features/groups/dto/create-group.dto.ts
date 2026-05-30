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

export class MealConfigDto {
  @IsOptional()
  @IsBoolean()
  mealsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  weeklyMenuEnabled?: boolean;

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
}
