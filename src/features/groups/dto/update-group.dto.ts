import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MealConfigDto,
  VALID_GROUP_TYPES,
  VALID_FUNCTIONAL_ROLES,
} from './create-group.dto';

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
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
