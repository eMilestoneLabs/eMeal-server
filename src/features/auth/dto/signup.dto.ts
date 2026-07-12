import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Student / regular user signup
export class StudentSignupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsEnum(['student', 'member', 'guest'])
  role: 'student' | 'member' | 'guest';

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'phone must be a valid mobile number' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password?: string;

  @IsOptional()
  @IsIn(['email', 'mobile'])
  loginPreference?: 'email' | 'mobile';

  // SRS AUTH-018 / Part 3 business rule: ages 13–99 only; under 13 is blocked.
  @IsOptional()
  @IsInt()
  @Min(13, { message: 'You must be at least 13 years old to register' })
  @Max(99, { message: 'age must be 99 or below' })
  age?: number;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['male', 'female', 'other', 'prefer_not_to_say'])
  gender?: string;
}

// Admin / manager signup
export class AdminSignupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsEnum(['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'])
  role: 'messManager' | 'hostelManager' | 'hostelAdmin' | 'organizationManager';

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'phone must be a valid mobile number' })
  phone?: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsIn(['email', 'mobile'])
  loginPreference?: 'email' | 'mobile';

  // Admins are adults; upper bound aligned with the SRS age range (max 99).
  @IsOptional()
  @IsInt()
  @Min(18, { message: 'Admins must be at least 18 years old' })
  @Max(99, { message: 'age must be 99 or below' })
  age?: number;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['male', 'female', 'other', 'prefer_not_to_say'])
  gender?: string;

  // Organization info for admin signup — MANDATORY and globally unique: an admin
  // must supply an organization name, and it may not collide with an existing
  // organization (enforced in the service on the normalized slug). Trim first so
  // a whitespace-only value is rejected by @IsNotEmpty.
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'Organization name is required' })
  @MaxLength(30, { message: 'Organization name must be 30 characters or fewer' })
  organizationName: string;

  @IsOptional()
  @IsString()
  organizationSlug?: string;
}

// Event admin signup
export class EventAdminSignupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, { message: 'phone must be a valid mobile number' })
  phone?: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @IsNotEmpty()
  eventName: string;

  @IsIn(['wedding', 'corporate', 'birthday', 'festival', 'conference', 'other'])
  eventType: string;

  @IsDateString()
  eventDate: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedGuestCount?: number;

  @IsOptional()
  @IsBoolean()
  autoDeleteAfter7Days?: boolean;
}
