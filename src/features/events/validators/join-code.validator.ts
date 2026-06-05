import { Injectable } from '@nestjs/common';
import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

/**
 * JoinCodeValidator — ensures event join codes meet format requirements.
 *
 * Join codes are auto-generated (CUID), but this validator can be used
 * for any user-submitted join code field to prevent injection.
 *
 * Rules:
 *   - Alphanumeric characters only
 *   - Length between 8 and 64 characters
 *   - No spaces or special characters
 */
@ValidatorConstraint({ name: 'joinCode', async: false })
@Injectable()
export class JoinCodeValidator implements ValidatorConstraintInterface {
  validate(value: string, _args: ValidationArguments): boolean {
    if (!value || typeof value !== 'string') return false;
    return /^[a-zA-Z0-9_-]{8,64}$/.test(value);
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'Join code must be 8-64 alphanumeric characters (letters, digits, hyphens, underscores)';
  }
}
