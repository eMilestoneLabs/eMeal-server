import { Equals, IsOptional, IsString } from 'class-validator';

/**
 * Pass 14 (FR-DEL-011) — self-service account deletion.
 *
 * `confirm` must be the literal string "DELETE" (explicit intent — this is
 * irreversible for the user). `password` is required for accounts that have
 * one; OTP-only accounts pass the confirm phrase alone.
 */
export class DeleteAccountDto {
  @Equals('DELETE', { message: 'Type DELETE to confirm account deletion' })
  confirm: string;

  @IsOptional()
  @IsString()
  password?: string;
}
