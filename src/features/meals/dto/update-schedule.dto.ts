import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  Max,
  IsBoolean,
  IsDateString,
  ValidateNested,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
// Live-Test-16 F1: one shared calendar-date guard (DRY) — see create-schedule.dto.
import {
  CALENDAR_DATE_RE,
  CALENDAR_DATE_MESSAGE,
} from './create-schedule.dto';

class ScheduleEntryWindowDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  openTime: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  closeTime: string;
}

/**
 * UpdateScheduleEntryDto — used in PATCH /schedules/:id
 * Includes optional id for existing entries (absent = create new).
 */
export class UpdateScheduleEntryDto {
  /** If present, updates existing entry. If absent, creates new entry. */
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @IsNotEmpty()
  mealId: string;

  @IsDateString()
  @Matches(CALENDAR_DATE_RE, { message: CALENDAR_DATE_MESSAGE })
  date: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  mealName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;

  /** Additive: per-day meal description override. null/absent = inherit master meal description. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  description?: string;

  /** Additive: per-day meal image override (base64 data URI or URL). null/absent = inherit master image. */
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleEntryWindowDto)
  attendanceWindow?: ScheduleEntryWindowDto | null;

  /** Per-day meal preference override (#6). */
  @IsOptional()
  @IsBoolean()
  preferencesEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledPreferences?: string[];

  /** #3: per-day SUBSET of the meal's master preference GROUP ids that apply
   * this day. Empty/absent = inherit ALL master groups (unchanged behaviour). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledPreferenceGroupIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  menuItems?: string[];

  /** Additive: per-day ₹ price (integer). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  price?: number;
}

/**
 * UpdateScheduleDto — PATCH /api/v1/schedules/:id
 *
 * Note: Cannot update a PUBLISHED schedule — service enforces this.
 * To update a published schedule, it must be unpublished first (B4 scope).
 *
 * replaceEntries=true replaces ALL existing entries with the provided list.
 * replaceEntries=false (default) merges — updates existing, creates new, leaves others.
 */
export class UpdateScheduleDto {
  /** Optionally shift the week (only valid on drafts) */
  @IsOptional()
  @IsDateString()
  @Matches(CALENDAR_DATE_RE, { message: CALENDAR_DATE_MESSAGE })
  weekStartDate?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateScheduleEntryDto)
  entries?: UpdateScheduleEntryDto[];

  /**
   * If true, replaces all entries with the provided list.
   * If false (default), merges with existing entries.
   */
  @IsOptional()
  replaceEntries?: boolean;
}

/**
 * CloneScheduleDto — POST /api/v1/schedules/:id/clone
 *
 * Clones a schedule to a new week, copying all entries
 * (mealNames and notes, but NOT overriding dates).
 * The clone starts as a DRAFT regardless of source's isPublished state.
 */
export class CloneScheduleDto {
  /**
   * Monday date of the target week for the cloned schedule.
   * Example: "2026-01-12"
   */
  @IsDateString()
  @Matches(CALENDAR_DATE_RE, { message: CALENDAR_DATE_MESSAGE })
  targetWeekStartDate: string;

  /**
   * Pass 15 (FR-SCHX-005): when the target week already has a schedule the
   * clone is rejected with 409 SCHEDULE_EXISTS unless `replace: true` is sent
   * — an explicit choice, never a silent overwrite.
   */
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}
