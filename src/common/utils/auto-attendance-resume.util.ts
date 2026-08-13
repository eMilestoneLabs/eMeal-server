/**
 * auto-attendance-resume.util.ts — Live-Test-11 ISSUE-004.
 *
 * Personal Auto-Attendance (ATT-010) materializes once per (meal, date)
 * behind a Redis once-key. A member on vacation at that moment is correctly
 * excluded — but when their vacation ends the SAME day (early return via the
 * toggle, an admin ending it, or the lifecycle sweep resuming them), the
 * once-key would silently swallow the rest of the day: auto-attendance
 * "never resumed".
 *
 * This helper clears the once-keys for the member's groups' meals for the
 * given business date, so the next sweep tick re-evaluates the (meal, date)
 * pairs and marks ONLY the newly-eligible member (everyone with an existing
 * record — including explicit unmarks — is skipped by the sweep's
 * `already`/skipDuplicates guards, so re-materialization can never override
 * a member's explicit action).
 *
 * Fire-and-forget by design: failures only delay resumption until the next
 * day, never break the caller's write. Zero cost for members who never
 * enabled auto-attendance.
 */

import { memberFlagWhere } from './member-settings.util';

type PrismaLite = {
  groupMember: { findMany: (args: unknown) => Promise<any[]> };
  meal: { findMany: (args: unknown) => Promise<any[]> };
};

type RedisLite = { del: (key: string) => Promise<unknown> };

export async function resumeAutoAttendanceForUser(
  prisma: PrismaLite,
  redis: RedisLite,
  params: { userId: string; organizationId: string; dateStr: string },
): Promise<void> {
  const { userId, organizationId, dateStr } = params;

  // Auto-attendance is per group, so the opt-in check IS the membership
  // filter: only groups whose EFFECTIVE setting is on need their once-keys
  // cleared. Folding it into the query the helper already ran replaces the
  // separate user point-read (one query fewer, not one more) and keeps the
  // early return for members who never enabled it anywhere.
  const memberships = await prisma.groupMember.findMany({
    where: {
      userId,
      status: 'active',
      group: { organizationId, isActive: true },
      ...memberFlagWhere('isDefaultAttendance', true),
    },
    select: { groupId: true },
  });
  if (!memberships.length) return;

  const meals = await prisma.meal.findMany({
    where: {
      organizationId,
      groupId: { in: memberships.map((m) => m.groupId) },
      attendanceEnabled: true,
    },
    select: { id: true },
  });
  await Promise.all(
    meals.map((m) =>
      redis.del(`autoattend:done:${organizationId}:${m.id}:${dateStr}`),
    ),
  );
}
