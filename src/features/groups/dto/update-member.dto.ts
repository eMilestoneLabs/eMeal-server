import { IsIn, IsOptional } from 'class-validator';

export class UpdateMemberDto {
  /**
   * Change membership role (admin/moderator only).
   */
  @IsOptional()
  @IsIn(['member', 'moderator', 'groupManager'], {
    message: 'role must be: member, moderator, or groupManager',
  })
  role?: string;

  /**
   * Change membership status.
   * - blocked: prevents attendance marking and group access
   * - active: restores access (unblock)
   * - removed: soft-removes from group (same as DELETE endpoint)
   */
  @IsOptional()
  @IsIn(['active', 'pending', 'blocked', 'removed'], {
    message: 'status must be: active, pending, blocked, or removed',
  })
  status?: string;
}
