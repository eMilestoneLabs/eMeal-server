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
