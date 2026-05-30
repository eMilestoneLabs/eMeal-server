import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  Matches,
  ValidateNested,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * AttendanceWindowDto — nested object for attendanceWindow field.
 * HH:mm format validated via regex.
 */
export class AttendanceWindowDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'openTime must be HH:mm format (e.g. "06:00", "23:30")',
  })
  openTime: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'closeTime must be HH:mm format (e.g. "09:00", "23:59")',
  })
  closeTime: string;
}

/**
 * Valid preference values for per-meal preference overrides.
 * Must stay lowercase — matches Flutter preference rendering.
 */
export const VALID_PREFERENCES = [
  'veg',
  'nonVeg',
  'egg',
  'chicken',
  'fish',
  'mutton',
  'jain',
  'vegan',
] as const;

/**
 * CreateMealDto — request body for POST /api/v1/meals
 *
 * slotKey is intentionally a free-form string — DO NOT add IsEnum().
 * This preserves the dynamic rendering architecture.
 */
export class CreateMealDto {
  @IsString()
  @IsNotEmpty()
  groupId: string;

  /**
   * Free-form slot identifier — admin-controlled.
   * Examples: "breakfast", "lunch", "dinner", "iftar", "sehri", "high-tea"
   * NEVER validated against an enum.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  slotKey: string;

  /** Internal admin-facing name. Used as displayName fallback. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  /** Student-facing display label. Null → serializer falls back to name. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string;

  /** Display order (lower = shown first). Default 0. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  order?: number;

  @IsOptional()
  @IsBoolean()
  attendanceEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(256, { each: true })
  menuItems?: string[];

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsBoolean()
  preferencesEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledPreferences?: string[];

  /** Attendance window — nested object, stored flat in DB */
  @IsOptional()
  @ValidateNested()
  @Type(() => AttendanceWindowDto)
  attendanceWindow?: AttendanceWindowDto;
}
