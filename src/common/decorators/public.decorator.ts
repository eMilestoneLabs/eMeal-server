import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/**
 * Mark a route as public — skips JWT guard.
 * Use on endpoints like event join (unauthenticated guests).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
