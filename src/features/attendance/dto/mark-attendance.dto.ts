import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsIn,
  Matches,
  MaxLength,
} from 'class-validator';

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
   * Exact lowercase values per Flutter preference system.
   */
  @IsOptional()
  @IsIn(['veg', 'chicken', 'fish', 'mutton', 'egg', 'jain'], {
    message: 'preference must be one of: veg, chicken, fish, mutton, egg, jain',
  })
  preference?: string;

  /** Optional student note. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
