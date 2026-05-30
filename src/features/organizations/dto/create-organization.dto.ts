import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  /**
   * Optional slug — auto-generated from name if not provided.
   * Must be lowercase alphanumeric with hyphens only.
   */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug?: string;

  /**
   * IANA timezone string, e.g. "Asia/Kolkata", "UTC", "America/New_York".
   * Defaults to "Asia/Kolkata" (IST) for MVP.
   */
  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;
}
