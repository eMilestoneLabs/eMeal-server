import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/paginated-response.dto';

/**
 * QueryCorrectionRequestDto — GET /api/v1/attendance/correction-requests.
 * Extends the shared pagination DTO so the response stays on
 * {data,total,page,limit}.
 */
export class QueryCorrectionRequestDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  groupId?: string;

  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'expired', 'cancelled'])
  status?: string;

  /** member = member-raised requests · admin_prompt = member confirmations. */
  @IsOptional()
  @IsIn(['member', 'admin_prompt'])
  sourceChannel?: string;
}
