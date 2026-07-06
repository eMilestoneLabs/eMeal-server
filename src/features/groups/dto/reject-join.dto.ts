import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * MEM-007: optional reason an admin may attach when rejecting a pending join
 * request. Trimmed + length-bounded; omitted = no reason.
 */
export class RejectJoinDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
