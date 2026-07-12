import {
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PreferenceSelectionDto } from '../../preferences/dto/preference-group.dto';

/**
 * Allowed request types (Module 33 / MIG-010).
 *
 * SRS Module 03 COR-004: a correction may target Present or Absent only —
 * 'correct_to_skip' has been REMOVED (Skip is an internal system status a
 * member can never select).
 */
export const CORRECTION_REQUEST_TYPES = [
  'claim_present',
  'correct_to_absent',
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

  @IsIn(CORRECTION_REQUEST_TYPES as unknown as string[], {
    // COR-004 exact wording — old APKs sending correct_to_skip get the real
    // business reason, not a generic validation failure.
    message:
      'Attendance cannot be corrected to Skip. Only Present or Absent are allowed.',
  })
  requestType: string;

  /** Required for fix_preference; the canonical lowercase preference key. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  requestedPreference?: string;

  /**
   * SRS Module 03 ATT-004/COR-006: the member's full preference-group
   * selection set — required (and validated exactly like normal marking)
   * when the correction targets Present on a meal with preference groups.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceSelectionDto)
  selections?: PreferenceSelectionDto[];

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
