import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * ReviewVacationRequestDto — optional note attached when an admin approves,
 * rejects, or cancels a request.
 */
export class ReviewVacationRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
