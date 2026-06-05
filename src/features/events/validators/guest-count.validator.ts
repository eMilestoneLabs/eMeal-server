import { Injectable } from '@nestjs/common';
import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/**
 * GuestCountValidator — ensures adult + children count is within allowed range.
 *
 * Rules:
 *   - Total guests (adults + children) must be >= 1
 *   - Max total guests per party = 50 (configurable)
 */
@ValidatorConstraint({ name: 'guestCount', async: false })
@Injectable()
export class GuestCountValidator implements ValidatorConstraintInterface {
  private static readonly MAX_PARTY_SIZE = 50;

  validate(_value: number, args: ValidationArguments): boolean {
    const obj = args.object as { adultsCount?: number; childrenCount?: number };
    const adults = obj.adultsCount ?? 1;
    const children = obj.childrenCount ?? 0;
    const total = adults + children;
    return total >= 1 && total <= GuestCountValidator.MAX_PARTY_SIZE;
  }

  defaultMessage(_args: ValidationArguments): string {
    return `Total guest count (adults + children) must be between 1 and ${GuestCountValidator.MAX_PARTY_SIZE}`;
  }
}
