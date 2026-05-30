import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsDateString,
  ValidateNested,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  date: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  mealName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  notes?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleEntryWindowDto)
  attendanceWindow?: ScheduleEntryWindowDto | null;
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
  targetWeekStartDate: string;
}
