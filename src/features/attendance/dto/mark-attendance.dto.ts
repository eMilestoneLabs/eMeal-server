import {
  IsArray,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsIn,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PreferenceSelectionDto } from '../../preferences/dto/preference-group.dto';

/**
 * DTO for POST /attendance — student marks own attendance.
 *
 * mealId + date uniquely identifies the attendance slot.
 * status defaults to "present" in service layer when not provided.
 */
export class MarkAttendanceDto {
  @IsString()
  @IsNotEmpty()
  mealId: string;

  /**
   * Attendance date as YYYY-MM-DD string.
   * Service converts to UTC midnight DateTime before persistence.
   */
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'attendanceDate must be YYYY-MM-DD format',
  })
  attendanceDate: string;

  /**
   * Attendance status. Defaults to "present" in service.
   * Students cannot set "onVacation" directly — vacation mode is toggled separately.
   */
  @IsOptional()
  @IsIn(['present', 'absent', 'skipped'], {
    message: 'status must be present | absent | skipped',
  })
  status?: string;

  /**
   * Meal preference — only valid when meal.preferencesEnabled=true.
   * Free-form (admin-driven custom tags); the admin defines the tag list per
   * meal/day, so any non-empty string up to 50 chars is accepted.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  preference?: string;

  /** Optional student note. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * Module 36 (FR-PG-013/031): multi-group selection set — required when the
   * meal has explicit preference groups and status is Present (FR-PG-032).
   * Legacy flat-preference meals keep using `preference` above unchanged.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceSelectionDto)
  selections?: PreferenceSelectionDto[];
}
