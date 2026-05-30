import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaginationQueryDto } from '../../../common/dto/paginated-response.dto';
import { VALID_GROUP_TYPES } from './create-group.dto';

export class QueryGroupsDto extends PaginationQueryDto {
  /**
   * Filter by group type (e.g., "hostel", "mess").
   */
  @IsOptional()
  @IsIn(VALID_GROUP_TYPES)
  type?: string;

  /**
   * Admin-only: include archived (isActive=false) groups.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;
}

export class QueryMembersDto extends PaginationQueryDto {
  /**
   * Filter members by status.
   */
  @IsOptional()
  @IsIn(['active', 'pending', 'blocked', 'removed'])
  status?: string;
}
