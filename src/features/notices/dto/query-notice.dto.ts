import { IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../../common/dto/paginated-response.dto';

/**
 * QueryNoticeDto — GET /api/v1/notices. Extends the shared pagination DTO so the
 * response stays on the {data,total,page,limit} contract.
 */
export class QueryNoticeDto extends PaginationQueryDto {
  /** Members pass their group id; org-wide notices are always included. */
  @IsOptional()
  @IsString()
  groupId?: string;

  /** Admin-only: include archived / soft-deleted notices. Ignored for members. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeInactive?: boolean;
}
