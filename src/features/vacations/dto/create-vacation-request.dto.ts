import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * CreateVacationRequestDto — POST /api/v1/vacation-requests (any member).
 * organizationId + userId are ALWAYS derived from the JWT, never the client.
 */
export class CreateVacationRequestDto {
  /** YYYY-MM-DD or full ISO-8601. Inclusive start of the vacation. */
  @IsISO8601()
  startDate: string;

  /** YYYY-MM-DD or full ISO-8601. Inclusive end of the vacation. */
  @IsISO8601()
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Optional group scope; null/omitted = organization-level request. */
  @IsOptional()
  @IsString()
  groupId?: string;

  /**
   * SRS FR-VACX-003 (Pass 11): optional meal-granular boundaries. On the
   * start date only meals from this slot onward are covered (e.g. leaving
   * after lunch → startSlotKey='dinner'). Omitted = whole day.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  startSlotKey?: string;

  /** Counterpart for the end date: covered up to and including this slot. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  endSlotKey?: string;
}
