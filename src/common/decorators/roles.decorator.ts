import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * @Roles(...roles) — mark a route as requiring specific JWT roles.
 * Used together with RolesGuard applied after JwtAuthGuard.
 *
 * Example:
 *   @Roles(...ADMIN_ROLES)
 *   @Post('groups')
 *   createGroup() {}
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

// ── Role constants — single source of truth ───────────────────────────────

/** Org-level admin roles — can manage groups, meals, members */
export const ADMIN_ROLES = [
  'messManager',
  'hostelManager',
  'hostelAdmin',
  'organizationManager',
] as const;

/** All admin roles including event admin */
export const ALL_ADMIN_ROLES = [...ADMIN_ROLES, 'eventAdmin'] as const;

/** Student/guest roles — read-only access to group features */
export const STUDENT_ROLES = ['student', 'member', 'guest'] as const;
