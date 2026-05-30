import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { JwtPayload } from '../decorators/current-user.decorator';

/**
 * RolesGuard — enforces @Roles(...) decorator.
 * Must be used AFTER JwtAuthGuard (request.user must be populated).
 *
 * Produces flat error contract: { message, errors, statusCode: 403 }
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *   @Roles(...ADMIN_ROLES)
 *   @Post('groups')
 *   createGroup() {}
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator — route is open to any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload | undefined = request.user;

    if (!user) {
      throw new ForbiddenException({
        message: 'Authentication required',
        errors: { auth: 'No authenticated user found' },
      });
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: {
          role: `This action requires one of: ${requiredRoles.join(', ')}. Your role: ${user.role}`,
        },
      });
    }

    return true;
  }
}
