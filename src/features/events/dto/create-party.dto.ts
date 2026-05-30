import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePartyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  primaryName: string; // M-16: "primaryName"

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  adultsCount?: number; // M-16: "adultsCount" NOT "adultCount"

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  childrenCount?: number; // M-16: "childrenCount" NOT "childCount"
}

export class UpdatePartyDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  primaryName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  adultsCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  childrenCount?: number;
}

export class UpdatePersonDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string; // M-17: "displayName" NOT "name"

  @IsOptional()
  @IsString()
  selectedMealTypeId?: string; // M-17: "selectedMealTypeId"

  @IsOptional()
  @IsString()
  mealPreference?: string; // M-17: "mealPreference"
}

export class UpdatePersonPresenceDto {
  @IsString()
  @IsNotEmpty()
  personId: string;

  isPresent: boolean; // M-17: isPresent field
}
