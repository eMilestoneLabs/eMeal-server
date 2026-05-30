/**
 * fcm-token.dto.ts — B6 Phase
 *
 * DTO for FCM token registration and device metadata.
 * Flutter sends this after receiving a new FCM token from Firebase.
 * MVP: token stored, no push sent. B7: token used for FCM delivery.
 */

import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class RegisterFcmTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  /** Firebase Cloud Messaging registration token */
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  /**
   * Device platform identifier.
   * Expected values: "android", "ios" — future use for platform-specific payloads.
   */
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  /** App version string for debugging expired tokens */
  appVersion?: string;
}
