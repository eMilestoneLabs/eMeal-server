import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  IsDateString,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['wedding', 'corporate', 'birthday', 'festival', 'conference', 'other'])
  type?: string;

  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  expectedGuestCount?: number;

  @IsOptional()
  @IsBoolean()
  autoDeleteAfter7Days?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
