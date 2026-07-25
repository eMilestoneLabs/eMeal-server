import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  AttendanceWindowDto,
  normalizeSlotKey,
  normalizeMealName,
} from './create-meal.dto';

/**
 * UpdateMealDto — request body for PATCH /api/v1/meals/:id
 * All fields optional — partial update semantics.
 */
export class UpdateMealDto {
  /**
   * Free-form slot key — can be changed post-creation.
   * NEVER an enum. Dynamic rendering architecture requires this to remain string.
   */
  // ISSUE-015: auto-normalized (trim + whitespace-collapse + lowercase).
  @Transform(({ value }) => normalizeSlotKey(value))
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slotKey?: string;

  // UNI-016: same normalize-on-write rule as create (trim + collapse spaces);
  // a RENAME must not be able to smuggle in a whitespace-variant duplicate.
  @Transform(({ value }) => normalizeMealName(value))
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;

  @Transform(({ value }) => normalizeMealName(value))
  @IsOptional()
  @IsString()
  @MaxLength(128)
  displayName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  order?: number;

  /** isEnabled in API = isActive in DB */
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  attendanceEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(256, { each: true })
  menuItems?: string[];

  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  preferencesEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledPreferences?: string[];

  /** Pass null to clear attendanceWindow. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AttendanceWindowDto)
  attendanceWindow?: AttendanceWindowDto | null;

  /** Additive: meal price in ₹ (integer). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  price?: number;
}

/**
 * ReorderMealsDto — request body for PATCH /api/v1/meals/reorder
 * Ordered array of meal IDs representing new display order.
 */
export class ReorderMealsDto {
  @IsString()
  groupId: string;

  @IsArray()
  @IsString({ each: true })
  mealIds: string[];
}
