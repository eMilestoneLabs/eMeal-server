import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsDateString,
} from 'class-validator';

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
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx'; // default = 'csv'

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
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx'; // default = 'csv'
}
