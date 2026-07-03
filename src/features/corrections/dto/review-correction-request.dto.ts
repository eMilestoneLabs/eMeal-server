import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * ReviewCorrectionRequestDto — approve / reject / cancel / confirm / decline
 * bodies (optional note).
 */
export class ReviewCorrectionRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
