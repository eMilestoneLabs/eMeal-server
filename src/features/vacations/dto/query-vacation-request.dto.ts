import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/paginated-response.dto';

/**
 * QueryVacationRequestDto — GET /api/v1/vacation-requests. Extends the shared
 * pagination DTO so the response stays on {data,total,page,limit}.
 */
export class QueryVacationRequestDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  groupId?: string;

  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected', 'cancelled'])
  status?: string;
}
