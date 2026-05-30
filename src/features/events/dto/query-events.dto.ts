import { IsOptional, IsBoolean, IsInt, Min, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class QueryEventsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  activeOnly?: boolean;

  @IsOptional()
  @IsString()
  type?: string;
}
