import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/** Allowed request types (Module 33 / MIG-010). */
export const CORRECTION_REQUEST_TYPES = [
  'claim_present',
  'correct_to_absent',
  'correct_to_skip',
  'fix_preference',
  'dispute_charge',
] as const;

/**
 * CreateCorrectionRequestDto — POST /api/v1/attendance/correction-requests
 * (any member, FR-ACR-001). organizationId + userId are ALWAYS derived from
 * the JWT, never the client.
 */
export class CreateCorrectionRequestDto {
  @IsString()
  mealId: string;

  /** YYYY-MM-DD — the meal's business date the correction applies to. */
  @IsISO8601()
  attendanceDate: string;

  @IsIn(CORRECTION_REQUEST_TYPES as unknown as string[])
  requestType: string;

  /** Required for fix_preference; the canonical lowercase preference key. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  requestedPreference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Optional photo evidence (MinIO URL). */
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(1000)
  evidenceUrl?: string;
}
