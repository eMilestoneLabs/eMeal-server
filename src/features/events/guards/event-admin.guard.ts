import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { JwtPayload } from '../../../common/decorators/current-user.decorator';

/**
 * EventAdminGuard — ensures the authenticated user is the event admin.
 *
 * Checks that the user created the event (adminId === user.sub).
 * Request must have 'event' attached by a prior EventOwnerInterceptor,
 * or the service layer enforces this check directly.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, EventAdminGuard)
 *   @Patch('/events/:id')
 */
@Injectable()
export class EventAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;
    const event = request.event; // set by EventOwnerInterceptor if used

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // If event is pre-loaded, validate admin ownership
    if (event && event.adminId !== user.sub) {
      throw new ForbiddenException('Only the event admin can perform this action');
    }

    return true;
  }
}
