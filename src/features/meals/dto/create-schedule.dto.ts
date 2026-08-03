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
  IsDateString,
  ValidateNested,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * ScheduleEntryAttendanceWindowDto — per-day timing override inside a schedule entry.
 */
/**
 * Live-Test-16 F1 — calendar-date guard.
 *
 * Every schedule date is parsed by `parseLocalDate` (`YYYY-MM-DD` → UTC
 * midnight). `@IsDateString()` alone also accepts a FULL ISO datetime, which
 * that parser turns into an **Invalid Date** — and an Invalid Date reaches
 * `toISOString()` and throws a RangeError (HTTP 500) instead of a clean 4xx.
 *
 * Guidebook §4 requires malformed date params to be rejected by regex BEFORE
 * Prisma (400, never 500). This constraint is ADDITIVE — `@IsDateString()`
 * stays, so the only requests newly rejected are the ones that were already
 * broken. Every client (Flutter included) sends `YYYY-MM-DD`.
 */
export const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CALENDAR_DATE_MESSAGE = 'date must be YYYY-MM-DD';

class ScheduleEntryWindowDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'openTime must be HH:mm format',
  })
  openTime: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'closeTime must be HH:mm format',
  })
  closeTime: string;
}

/**
 * CreateScheduleEntryDto — a single day+meal assignment inside a schedule.
 *
 * slotKey is derived server-side from the referenced meal.
 * Day of week is also derived server-side from the date field.
 */
export class CreateScheduleEntryDto {
  @IsString()
  @IsNotEmpty()
  mealId: string;

  /**
   * Specific date for this entry in YYYY-MM-DD format.
   * Day of week (dayOfWeek integer) is computed from this date.
   */
  @IsDateString()
  @Matches(CALENDAR_DATE_RE, { message: CALENDAR_DATE_MESSAGE })
  date: string;

  /** What's being served on this day (e.g. "Poha", "Dal Rice with Raita") */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  mealName?: string;

  /** Optional student-facing notes (e.g. "Extra fruits today", "No fish available") */
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

  /** Per-day attendance window override. Null = use meal template's window. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleEntryWindowDto)
  attendanceWindow?: ScheduleEntryWindowDto;

  /** Per-day meal preference override (#6). null/absent = inherit from meal. */
  @IsOptional()
  @IsBoolean()
  preferencesEnabled?: boolean;

  /** Per-day enabled preference tags (#6). */
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

  /** Additive: per-day ₹ price (integer). null = inherit master meal price. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  price?: number;
}

/**
 * CreateScheduleDto — request body for POST /api/v1/schedules
 *
 * weekStartDate MUST be a Monday (validated in service, not DTO,
 * to keep validation logic testable).
 */
export class CreateScheduleDto {
  @IsString()
  @IsNotEmpty()
  groupId: string;

  /**
   * ISO date string for the Monday of the schedule week.
   * Example: "2026-01-05" (a Monday).
   * Non-Monday dates are rejected in the service layer.
   */
  @IsDateString()
  @Matches(CALENDAR_DATE_RE, { message: CALENDAR_DATE_MESSAGE })
  weekStartDate: string;

  /** Optional initial entries — can be added/updated later */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateScheduleEntryDto)
  entries?: CreateScheduleEntryDto[];
}
