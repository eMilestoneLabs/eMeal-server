import {
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  IsISO8601,
  MaxLength,
} from 'class-validator';

/**
 * UpdateNoticeDto — PATCH /api/v1/notices/:id (admin). All fields optional.
 * Soft delete / restore is done by toggling isActive.
 */
export class UpdateNoticeDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string;

  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
