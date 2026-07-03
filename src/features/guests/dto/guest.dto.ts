import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One hosted guest in a booking request (FR-HG-031/081). */
export class GuestRowDto {
  @IsOptional()
  @IsBoolean()
  isAdult?: boolean; // default true

  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  mealPreference?: string;
}

/** POST /attendance/:mealId/guests — book N guests (FR-HG-001/080). */
export class BookGuestsDto {
  @Matches(DATE_RE, { message: 'attendanceDate must be YYYY-MM-DD' })
  attendanceDate: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => GuestRowDto)
  guests: GuestRowDto[];

  /**
   * FR-HG-062: admins booking ON BEHALF of a host set this; the booking is
   * created pendingApproval until the HOST confirms (liability increase —
   * FR-FAIR-001). Ignored (must equal the caller) for member calls.
   */
  @IsOptional()
  @IsString()
  hostUserId?: string;
}

/** PATCH /attendance/guests/:id — edit name/preference (FR-HG-033). */
export class UpdateGuestDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  mealPreference?: string;
}

export class QueryGuestsDto {
  @IsOptional()
  @Matches(DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsString()
  groupId?: string;

  @IsOptional()
  @IsString()
  mealId?: string;

  @IsOptional()
  @IsString()
  hostUserId?: string;
}

export class ReviewGuestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
