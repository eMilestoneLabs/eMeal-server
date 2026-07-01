import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  /**
   * Single identifier field — can be email or mobile number.
   * Flutter sends one field, backend detects which by presence of "@".
   */
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export class OtpRequestDto {
  @IsString()
  @IsNotEmpty()
  identifier: string; // email or phone

  @IsOptional()
  @IsString()
  purpose?: 'login' | 'signup' | 'reset';

  // Workspace the request came from: 'student' | 'admin' | 'event'.
  // For reset, scopes the account lookup so a missing / wrong-workspace account
  // is reported clearly (Issue 5).
  @IsOptional()
  @IsString()
  roleContext?: string;
}

export class OtpVerifyDto {
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @IsString()
  @IsNotEmpty()
  otp: string;

  @IsOptional()
  @IsString()
  purpose?: string;
}

export class ForgotPasswordDto {
  @IsString()
  @IsNotEmpty()
  identifier: string; // email (AUTH-017: Email OTP only)

  // Workspace the reset was initiated from ('student' | 'admin' | 'event').
  @IsOptional()
  @IsString()
  roleContext?: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  identifier: string;

  @IsString()
  @IsNotEmpty()
  otp: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  newPassword: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class FcmTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}
