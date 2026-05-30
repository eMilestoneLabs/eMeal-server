import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsInt,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMealTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  title: string; // M-14: "title" NOT "name"

  @IsOptional()
  @IsString()
  @MaxLength(10)
  emoji?: string; // M-14: emoji string

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  colorValue?: number; // M-14: ARGB32 integer

  @IsOptional()
  @IsBoolean()
  isVeg?: boolean;
}

export class UpdateMealTypeDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  emoji?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  colorValue?: number;

  @IsOptional()
  @IsBoolean()
  isVeg?: boolean;
}
