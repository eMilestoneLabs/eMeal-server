import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  Matches,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Single entry in a bulk attendance submission.
 */
export class BulkAttendanceEntryDto {
  @IsString()
  @IsNotEmpty()
  mealId: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'attendanceDate must be YYYY-MM-DD format',
  })
  attendanceDate: string;

  @IsOptional()
  @IsIn(['present', 'absent', 'skipped'])
  status?: string;

  @IsOptional()
  @IsString()
  preference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * DTO for POST /attendance/bulk — student marks multiple meals at once.
 * Useful for weekly default attendance setup or day-ahead marking.
 */
export class BulkAttendanceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(21) // 3 meals × 7 days max
  @ValidateNested({ each: true })
  @Type(() => BulkAttendanceEntryDto)
  entries: BulkAttendanceEntryDto[];
}
