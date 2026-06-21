import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsBoolean,
  IsISO8601,
  MaxLength,
} from 'class-validator';

/**
 * CreateNoticeDto — POST /api/v1/notices (admin).
 *
 * organizationId is NEVER taken from the client — it derives from the JWT.
 * groupId omitted/null = organization-wide notice.
 */
export class CreateNoticeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body: string;

  /** null / omitted = organization-wide notice. */
  @IsOptional()
  @IsString()
  groupId?: string;

  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  /** ISO-8601; null/omitted = never expires. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
