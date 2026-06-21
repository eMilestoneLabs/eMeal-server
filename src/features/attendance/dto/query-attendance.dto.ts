import {
  IsString,
  IsOptional,
  IsIn,
  IsNumberString,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Query DTO for GET /attendance — paginated attendance history.
 */
export class QueryAttendanceDto {
  /** Filter by group (required for most queries) */
  @IsOptional()
  @IsString()
  groupId?: string;

  /** Filter by specific meal */
  @IsOptional()
  @IsString()
  mealId?: string;

  /** Filter by specific user (admin only — students always see their own) */
  @IsOptional()
  @IsString()
  userId?: string;

  /** Filter from date (inclusive) — YYYY-MM-DD */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fromDate must be YYYY-MM-DD' })
  fromDate?: string;

  /** Filter to date (inclusive) — YYYY-MM-DD */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate must be YYYY-MM-DD' })
  toDate?: string;

  /** Filter by status */
  @IsOptional()
  @IsIn(['present', 'absent', 'skipped', 'onVacation'])
  status?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  limit?: number = 20;
}

/**
 * Query DTO for GET /attendance/summary — aggregate counts for a user.
 */
export class QuerySummaryDto {
  @IsString()
  groupId: string;

  /** Optional userId — admin can query any user; student defaults to self */
  @IsOptional()
  @IsString()
  userId?: string;

  /** Start of summary period — YYYY-MM-DD */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fromDate must be YYYY-MM-DD' })
  fromDate?: string;

  /** End of summary period — YYYY-MM-DD */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate must be YYYY-MM-DD' })
  toDate?: string;

  /** Include per-meal breakdown (admin only) */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeMealBreakdown?: boolean = false;
}

/**
 * Query DTO for GET /attendance/meal-summary — per-meal aggregate for admin.
 */
export class QueryMealSummaryDto {
  @IsString()
  mealId: string;

  /** Date to summarize — YYYY-MM-DD */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;
}


/**
 * Query DTO for GET /attendance/billing-summary — group-wide billing
 * aggregation for the Member Billing V2 dashboard (admin only). Accurate at
 * any scale (server-side aggregation, no client record cap).
 */
export class QueryBillingDto {
  @IsString()
  groupId: string;

  /** Start of billing period — YYYY-MM-DD */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fromDate must be YYYY-MM-DD' })
  fromDate?: string;

  /** End of billing period — YYYY-MM-DD */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate must be YYYY-MM-DD' })
  toDate?: string;
}

/**
 * Query DTO for GET /attendance/billing-series — bucketed time-series for the
 * Member Billing analytics charts (admin only). bucket = day | week | month.
 */
export class QueryBillingSeriesDto {
  @IsString()
  groupId: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fromDate must be YYYY-MM-DD' })
  fromDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate must be YYYY-MM-DD' })
  toDate?: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  bucket?: string = 'day';
}
