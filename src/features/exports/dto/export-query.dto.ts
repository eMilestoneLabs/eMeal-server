import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsDateString,
} from 'class-validator';

/**
 * SRS Module 03 RPT-001: exports are Excel (.xlsx) multi-sheet workbooks with
 * an optional PDF summary — CSV is NOT supported. 'csv' is rejected with a
 * clear message so pre-RPT-001 APKs get an actionable error instead of a
 * generic validation failure.
 */
const CSV_REMOVED_MESSAGE =
  'CSV export is no longer supported. Please use Excel (.xlsx) instead.';

export class AttendanceExportQueryDto {
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @IsDateString()
  fromDate: string; // YYYY-MM-DD

  @IsDateString()
  toDate: string; // YYYY-MM-DD

  @IsOptional()
  @IsString()
  @IsIn(['xlsx'], { message: CSV_REMOVED_MESSAGE })
  format?: 'xlsx'; // default = 'xlsx' (RPT-001)

  @IsOptional()
  @IsString()
  userId?: string; // optional: export for specific user only
}

export class EventExportQueryDto {
  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsOptional()
  @IsString()
  @IsIn(['xlsx'], { message: CSV_REMOVED_MESSAGE })
  format?: 'xlsx'; // default = 'xlsx' (RPT-001)
}
