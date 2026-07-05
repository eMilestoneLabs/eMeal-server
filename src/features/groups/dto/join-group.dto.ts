import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * #2: member-level roles a joining user may pick as their per-group display
 * title. ADMIN roles are intentionally excluded — a join can never grant or
 * self-assign an admin/manager title (display-only, permissions unchanged).
 */
export const JOINABLE_MEMBER_ROLES = ['student', 'member', 'guest'] as const;

export class JoinGroupDto {
  /**
   * The join code displayed on the group QR code.
   * Stored as joinToken in DB — exposed as joinCode in API.
   * Flutter sends: { "joinCode": "HTL3K8XZ" }
   *
   * Normalized to uppercase so manual entry "htl3k8xz" also works.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase().trim() : value))
  joinCode: string;

  /**
   * #2: the member's chosen display role FOR THIS group (per-group, never
   * global). Optional — omitting it keeps the legacy behaviour (display falls
   * back to the user's global role). Only member-level values are accepted; an
   * admin/manager title here is rejected (422) so a join can never escalate a
   * display title. Permissions are ALWAYS the authenticated account's.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(JOINABLE_MEMBER_ROLES as unknown as string[], {
    message: `functionalRole must be one of: ${JOINABLE_MEMBER_ROLES.join(', ')}`,
  })
  functionalRole?: string;
}
