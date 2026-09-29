/**
 * Live-Test-16 — compile-time proof for the query fragments this batch adds
 * through object SPREADS. TypeScript skips excess-property checks on spread
 * members, so a mistyped field there would only fail at runtime
 * (PrismaClientValidationError). Pinning each fragment to Prisma's GENERATED
 * WhereInput types makes `tsc --noEmit` / ts-jest fail if a field is renamed
 * or removed in schema.prisma. Test-only; never compiled into dist.
 */
import { Prisma } from '@prisma/client';

describe('LT-16 Prisma query shapes (type-checked against the schema)', () => {
  it('notices: the author exclusion in unreadCount is a valid Notice filter', () => {
    const where: Prisma.NoticeWhereInput = {
      reads: { none: { userId: 'u-1' } },
      createdBy: { not: 'u-1' },
    };
    expect(where.createdBy).toEqual({ not: 'u-1' });
  });

  it('notifications: the group-path push exclusion is a valid GroupMember filter', () => {
    const where: Prisma.GroupMemberWhereInput = {
      groupId: 'g-1',
      status: 'active',
      userId: { not: 'u-1' },
      user: { remindersEnabled: true, fcmToken: { not: null } },
    };
    expect(where.userId).toEqual({ not: 'u-1' });
  });

  it('notifications: the org-path push exclusion is a valid User filter', () => {
    const where: Prisma.UserWhereInput = {
      organizationId: 'o-1',
      remindersEnabled: true,
      fcmToken: { not: null },
      id: { not: 'u-1' },
    };
    expect(where.id).toEqual({ not: 'u-1' });
  });

  it('vacations: the taken-meal record filter is a valid AttendanceRecord filter', () => {
    const where: Prisma.AttendanceRecordWhereInput = {
      organizationId: 'o-1',
      userId: 'u-1',
      attendanceDate: new Date('2026-09-29T00:00:00.000Z'),
      status: { in: ['present', 'absent', 'skipped'] },
      groupId: 'g-1',
    };
    expect(where.status).toBeDefined();
  });
});
