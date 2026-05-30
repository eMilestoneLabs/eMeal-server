import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * DTO for POST /attendance/admin/override — admin marks attendance for any user.
 *
 * Admin override bypasses:
 *   - Attendance window timing
 *   - Vacation mode check
 *   - (Does NOT bypass org isolation — still enforced in service)
 *
 * markedBy is set from JWT (not from client payload — prevents spoofing).
 */
export class AdminOverrideDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  mealId: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'attendanceDate must be YYYY-MM-DD format',
  })
  attendanceDate: string;

  @IsIn(['present', 'absent', 'skipped', 'onVacation'], {
    message: 'status must be present | absent | skipped | onVacation',
  })
  status: string;

  @IsOptional()
  @IsIn(['veg', 'chicken', 'fish', 'mutton', 'egg', 'jain'])
  preference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
