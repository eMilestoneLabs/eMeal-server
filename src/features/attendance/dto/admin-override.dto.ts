import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PreferenceSelectionDto } from '../../preferences/dto/preference-group.dto';

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

  /**
   * Module 36 (FR-PG-013/031) parity for the ATT-004 SELF-mark delegate: an
   * admin marking their OWN attendance on a meal with explicit preference
   * groups sends the same selection set a member would — the delegated
   * member path validates and persists them under identical FR-PG rules.
   * Optional and ignored for legacy flat-preference meals.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceSelectionDto)
  selections?: PreferenceSelectionDto[];

  /**
   * Live-Test-11 ISSUE-010: admin SAME-DAY self-correction. When true (and
   * userId === the admin's own id), the closed-window gate is relaxed for
   * TODAY only — no approval flow, directly applied, always audited. Any
   * other date or an upcoming window still returns 423.
   */
  @IsOptional()
  @IsBoolean()
  correction?: boolean;
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
