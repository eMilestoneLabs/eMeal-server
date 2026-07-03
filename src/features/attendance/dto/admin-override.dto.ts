import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO for POST /attendance/admin/override — admin marks attendance for any user.
 *
 * Admin override bypasses:
 *   - Attendance window timing
 *   - Vacation mode check
 *   - (Does NOT bypass org isolation — still enforced in service)
 *
 * markedBy is set from JWT (not from client payload — prevents spoofing).
 */
export class AdminOverrideDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  mealId: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'attendanceDate must be YYYY-MM-DD format',
  })
  attendanceDate: string;

  @IsIn(['present', 'absent', 'skipped', 'onVacation'], {
    message: 'status must be present | absent | skipped | onVacation',
  })
  status: string;

  @IsOptional()
  @IsString()
  preference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * SRS FR-ATT-033 (Pass 7): governed bulk override. Each row is classified
 * independently (FR-OVR-001) — increases are held for member consent, never
 * applied. The service enforces the configurable row cap (LOOP-032 partial
 * control against unbounded mass changes).
 */
export class AdminBulkOverrideDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AdminOverrideDto)
  rows: AdminOverrideDto[];

  /** Applied as the per-row note when a row has none (audited). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
