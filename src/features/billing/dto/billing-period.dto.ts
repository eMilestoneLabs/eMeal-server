import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** SRS FR-DISP-010: finalize (lock) a billing period for a group. */
export class FinalizePeriodDto {
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @Matches(DATE_RE, { message: 'periodStart must be YYYY-MM-DD' })
  periodStart: string;

  @Matches(DATE_RE, { message: 'periodEnd must be YYYY-MM-DD' })
  periodEnd: string;
}

/** SRS FR-DISP-010: controlled reopen — reason is mandatory (audited). */
export class ReopenPeriodDto {
  @IsString()
  @IsNotEmpty({ message: 'A reopen reason is required' })
  @MaxLength(500)
  reason: string;
}

export class QueryPeriodsDto {
  @IsOptional()
  @IsString()
  groupId?: string;
}
