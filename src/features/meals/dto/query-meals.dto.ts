import { IsOptional, IsString, IsBoolean, IsInt, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaginationQueryDto } from '../../../common/dto/paginated-response.dto';

/**
 * QueryMealsDto — query params for GET /api/v1/meals
 */
export class QueryMealsDto extends PaginationQueryDto {
  /** Filter by group — REQUIRED for non-admin roles */
  @IsOptional()
  @IsString()
  groupId?: string;

  /** Filter by slotKey (e.g. "breakfast") */
  @IsOptional()
  @IsString()
  slotKey?: string;

  /**
   * Include soft-deleted meals (isActive=false).
   * Admin-only; ignored for student role.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeDisabled?: boolean;
}

/**
 * QuerySchedulesDto — query params for GET /api/v1/schedules
 */
export class QuerySchedulesDto extends PaginationQueryDto {
  /** Filter by group — REQUIRED */
  @IsOptional()
  @IsString()
  groupId?: string;

  /**
   * Only return published schedules (for student view).
   * Defaults to false (admin sees all including drafts).
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  publishedOnly?: boolean;
}
