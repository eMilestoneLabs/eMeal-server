import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  IsDateString,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['wedding', 'corporate', 'birthday', 'festival', 'conference', 'other'])
  type: string;

  @IsDateString()
  eventDate: string; // ISO date string — parsed to DateTime in service

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  expectedGuestCount?: number;

  @IsOptional()
  @IsBoolean()
  autoDeleteAfter7Days?: boolean;
}
