import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  MealConfigDto,
  VALID_GROUP_TYPES,
  VALID_FUNCTIONAL_ROLES,
} from './create-group.dto';

export class UpdateGroupDto {
  // SRS FR-GRP-013 (Pass 10): a PATCHed name may be omitted, never empty.
  // Trimmed BEFORE validation — IsNotEmpty alone accepts whitespace-only
  // strings (caught live in the Pass 10 server validation).
  @IsOptional()
  // UNI-005 (unique_mandatory_rules.xlsx): Group Name normalization is
  // "Trim -> Collapse Spaces -> Lowercase". Trim alone let a whitespace
  // variant ("Boys  Hostel") slip past the org-scoped uniqueness gate as a
  // distinct name; lowercase is applied at COMPARISON time
  // (existsActiveByNameType uses mode: 'insensitive'), so display casing is
  // preserved here.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Group name cannot be empty' })
  @MinLength(2)
  @MaxLength(50) // SRS GRP-003: Group Name 2–50 characters.
  name?: string;

  // BUG-002 contract: normalize Flutter's "factory_" → "factory" before @IsIn
  // (mirrors CreateGroupDto + GroupSerializer.normalizeTypeForDb).
  @IsOptional()
  @Transform(({ value }) => (value === 'factory_' ? 'factory' : value))
  @IsIn(VALID_GROUP_TYPES)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxMembers?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Partial mealConfig update — only provided fields are updated.
   * Supports dynamic rendering toggles (admin turns meals on/off etc.)
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => MealConfigDto)
  mealConfig?: MealConfigDto;

  /**
   * Additive (#8): update the requesting admin's functional role for THIS group.
   * Applies to the requester's own membership (per-group title).
   */
  @IsOptional()
  @IsIn(VALID_FUNCTIONAL_ROLES, {
    message: `functionalRole must be one of: ${VALID_FUNCTIONAL_ROLES.join(', ')}`,
  })
  functionalRole?: string;
}
