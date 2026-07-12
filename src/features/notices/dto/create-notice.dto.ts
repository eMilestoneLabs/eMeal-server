import {
  ArrayMaxSize,
  IsArray,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsBoolean,
  IsISO8601,
  IsUrl,
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

  /**
   * SRS Module 03 NTC-012: at most ONE image as a base64 data URI
   * (JPG/JPEG/PNG/WEBP). The client auto-compresses; the server enforces the
   * hard ≤100 KB decoded limit and stores a MinIO URL — never base64.
   * ~140 KB base64 ceiling guards the transport (100 KB × 4/3 + headroom).
   */
  @IsOptional()
  @IsString()
  @MaxLength(160_000)
  imageData?: string;

  /**
   * SRS Module 03 NTC-013: at most ONE document as a base64 data URI
   * (PDF/DOC/DOCX/TXT), decoded ≤50 KB. Stored as a MinIO URL.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80_000)
  documentData?: string;

  /** Original filename shown to readers (extension decides the type). */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  documentName?: string;

  /** SRS Module 03 NTC-003: optional external hyperlinks (validated URLs). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUrl({ require_protocol: true }, { each: true })
  @MaxLength(1000, { each: true })
  externalLinks?: string[];
}
