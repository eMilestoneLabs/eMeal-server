import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Pass 12 (SRS FR-BILLX-030/031/033, LOOP-010, GAP-103) — append-only billing
 * adjustments. Amounts are positive integer minor units; the sign is derived
 * from `type` (credit/refund decrease the bill, debit increases it).
 */
export class CreateAdjustmentDto {
  @IsString()
  @IsNotEmpty()
  groupId: string;

  /** The member whose bill this entry adjusts. */
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsIn(['credit', 'debit', 'refund'])
  type: 'credit' | 'debit' | 'refund';

  /**
   * Positive minor units (paise) — FR-BILLX-005 (LOOP-011). Capped at
   * ₹1,00,000 per entry: larger legitimate corrections are posted as
   * multiple reasoned entries, and a fat-fingered amount can never nuke
   * or inflate a bill by orders of magnitude in one keystroke.
   */
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  amount: number;

  /** Mandatory human explanation (LOOP-010) — trimmed before validation. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason: string;

  /** Business date the entry posts to (YYYY-MM-DD). Default: today (org tz). */
  @IsOptional()
  @IsISO8601()
  entryDate?: string;

  @IsOptional()
  @IsString()
  refRecordId?: string;

  @IsOptional()
  @IsString()
  refGuestId?: string;

  /**
   * FR-FAIR-001: a DEBIT (liability increase) must carry the id of an
   * APPROVED AttendanceCorrectionRequest for the same member — consent proof.
   */
  @IsOptional()
  @IsString()
  refRequestId?: string;
}

export class QueryAdjustmentsDto {
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsISO8601()
  fromDate?: string;

  @IsOptional()
  @IsISO8601()
  toDate?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;
}
