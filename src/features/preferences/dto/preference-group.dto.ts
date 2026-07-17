import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsLowercase,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** One option inside a group (FR-PG-011). */
export class PreferenceOptionDto {
  @IsString()
  @IsLowercase()
  @Matches(/^[a-z0-9_-]+$/, { message: 'key must be lowercase a-z, 0-9, _ or -' })
  @Length(1, 40)
  key!: string;

  @IsString()
  @Length(1, 60)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  emoji?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsBoolean()
  isVeg?: boolean;

  /** ₹ minor units added to base price; never negative (FR-PG-081). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  priceDelta?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minQty?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxQty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

/** FR-PG-060 conditional visibility dependency. */
export class VisibleWhenDto {
  @IsString()
  groupId!: string;

  @IsString()
  optionKey!: string;
}

/** Create a preference group — meal-scoped or reusable template (FR-PG-010/080). */
export class CreatePreferenceGroupDto {
  @IsString()
  @Length(1, 60)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsIn(['single', 'multiple'])
  selectionType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxSelect?: number;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  quantityEnabled?: boolean;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => VisibleWhenDto)
  visibleWhen?: VisibleWhenDto;

  @IsOptional()
  @IsBoolean()
  vegOnly?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PreferenceOptionDto)
  options?: PreferenceOptionDto[];

  /** Bind an EXISTING template instead of creating a new group (FR-PG-022). */
  @IsOptional()
  @IsString()
  preferenceGroupId?: string;

  // Per-meal binding rule overrides (FR-PG-012) — used on POST /meals/:id/…
  @IsOptional()
  @IsBoolean()
  requiredOverride?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSelectOverride?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxSelectOverride?: number;
}

/** Partial update of a group (FR-PG-080). */
export class UpdatePreferenceGroupDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsIn(['single', 'multiple'])
  selectionType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxSelect?: number;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  quantityEnabled?: boolean;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => VisibleWhenDto)
  visibleWhen?: VisibleWhenDto;

  @IsOptional()
  @IsBoolean()
  vegOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Partial update of an option — key is intentionally NOT updatable (FR-PG-072). */
export class UpdatePreferenceOptionDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  emoji?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsBoolean()
  isVeg?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  priceDelta?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minQty?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxQty?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Live-Test-8 ISSUE-001/002: suspend/restore ALL of a meal's group bindings —
 * the non-destructive Standalone↔Groups mode switch.
 */
export class SetMealBindingsActiveDto {
  @IsBoolean()
  active!: boolean;
}

/** One chosen option in a member's selection set (FR-PG-013/031). */
export class PreferenceSelectionDto {
  @IsString()
  groupId!: string;

  @IsString()
  @IsLowercase()
  @Length(1, 40)
  optionKey!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}
