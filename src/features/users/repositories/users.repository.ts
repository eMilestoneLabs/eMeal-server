import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { UserEntity } from '../entities/user.entity';
import { UserRole } from '@prisma/client';
import {
  getTodayInTimezone,
  toUtcMidnight,
} from '../../../common/utils/date.utils';

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build UserEntity from a Prisma User record that already has
   * `members` included via Prisma include clause.
   * Using include on the parent query eliminates the N+1 pattern
   * where buildEntity() previously fired one GroupMember query per user.
   */
  private buildEntityFromInclude(user: any): UserEntity {
    const groupIds = (user.groupMembers ?? [])
      .filter((m: any) => m.status === 'active')
      .map((m: any) => m.groupId);
    return new UserEntity({
      ...user,
      groupIds,
      groupId: groupIds[0] ?? null,
    });
  }

  /** Include clause reused across all single-record finders. */
  private get memberInclude() {
    return {
      groupMembers: {
        where: { status: 'active' as const },
        select: { groupId: true, status: true },
      },
    };
  }

  async findById(id: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  /**
   * Pass 11 (FR-VACX-006): read-time vacation flag sync, org-timezone-correct.
   * Called on GET /users/me so the flag is right the moment the app opens —
   * the lifecycle sweep covers users who never open the app.
   *
   * Rules (two vacation modes, FR-VACX-001):
   *   • An approved request covers today (org time) and the flag is OFF →
   *     flip ON (future-dated approval reaching its start date).
   *   • The flag is ON, the user HAS approved requests, and none covers
   *     today → flip OFF (auto-resume the day after endDate, org time).
   *   • Pure-toggle users (no approved requests at all) are NEVER touched —
   *     the instant toggle is its own mode and must not silently die.
   */
  async syncVacationExpiry(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isVacationMode: true,
        organization: { select: { timezone: true } },
      },
    });
    if (!user) return;

    const tz = user.organization?.timezone ?? 'Asia/Kolkata';
    const todayUtc = toUtcMidnight(getTodayInTimezone(tz));

    const covering = await this.prisma.vacationRequest.findFirst({
      where: {
        userId,
        status: 'approved',
        deletedAt: null,
        startDate: { lte: todayUtc },
        endDate: { gte: todayUtc },
      },
      select: { id: true },
    });

    if (covering && !user.isVacationMode) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { isVacationMode: true },
      });
      return;
    }
    if (!covering && user.isVacationMode) {
      // Only request-driven flags auto-resume; toggle-mode flags stay.
      const hasAnyApproved = await this.prisma.vacationRequest.findFirst({
        where: { userId, status: 'approved', deletedAt: null },
        select: { id: true },
      });
      if (hasAnyApproved) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { isVacationMode: false },
        });
      }
    }
  }

  /**
   * SRS Module 03 VAC-005/006/012 (BUG-VAC-SELF-SERVE): Return Early.
   * Turning vacation OFF must PERSIST — but syncVacationExpiry force-flips the
   * flag back ON while an approved request still covers today. Ending the
   * covering request(s) is the only durable OFF: the vacation record itself
   * ends at the return point, so no read-time sync or lifecycle sweep can
   * re-enable it. Approval mode is deliberately NOT consulted — Return Early
   * is always self-service (VAC-005), even in approval mode.
   *
   *   • Request started before today → shorten: endDate = yesterday (history
   *     keeps the days actually taken; today's remaining meals reactivate).
   *   • Request starting today → cancel outright (no day was consumed; a
   *     zero-length approved range cannot be represented).
   *
   * Future-dated approved requests are untouched — they are separate
   * vacations, not the one being returned from. Returns the ended request ids
   * so the caller can audit the action (VAC-013).
   */
  async endCoveringVacationRequests(userId: string): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organization: { select: { timezone: true } } },
    });
    if (!user) return [];

    const tz = user.organization?.timezone ?? 'Asia/Kolkata';
    const todayUtc = toUtcMidnight(getTodayInTimezone(tz));

    const covering = await this.prisma.vacationRequest.findMany({
      where: {
        userId,
        status: 'approved',
        deletedAt: null,
        startDate: { lte: todayUtc },
        endDate: { gte: todayUtc },
      },
      select: { id: true, startDate: true },
    });
    if (covering.length === 0) return [];

    const yesterdayUtc = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);
    await this.prisma.$transaction(
      covering.map((r) =>
        r.startDate.getTime() < todayUtc.getTime()
          ? this.prisma.vacationRequest.update({
              where: { id: r.id },
              data: { endDate: yesterdayUtc },
            })
          : this.prisma.vacationRequest.update({
              where: { id: r.id },
              data: { status: 'cancelled', reviewedAt: new Date() },
            }),
      ),
    );
    return covering.map((r) => r.id);
  }

  /**
   * Pass 11 (FR-VACX-001): does any of the user's active groups require the
   * dated-request approval flow (instant toggle disabled)?
   */
  async vacationRequiresApproval(userId: string): Promise<boolean> {
    const hit = await this.prisma.groupMember.findFirst({
      where: {
        userId,
        status: 'active',
        group: { isActive: true, vacationRequiresApproval: true },
      },
      select: { groupId: true },
    });
    return !!hit;
  }

  /** fcmToken for fire-and-forget notifications (LOOP-041). */
  async getPushTarget(
    userId: string,
  ): Promise<{ userId: string; fcmToken: string; organizationId: string | null } | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true, organizationId: true },
    });
    return u?.fcmToken
      ? { userId, fcmToken: u.fcmToken, organizationId: u.organizationId }
      : null;
  }

  /**
   * Emails are matched CASE-INSENSITIVELY everywhere (login, signup dup-check,
   * password reset). Rows created before 2026-07-04 may store mixed case
   * (e.g. "Manas.B…@gmail.com"), so exact matching locked users out when they
   * typed lowercase. Writes normalize to lowercase via normalizeEmail below.
   */
  private static emailWhere(email: string) {
    return { email: { equals: email.trim(), mode: 'insensitive' as const } };
  }

  private static normalizeEmail<T extends string | undefined>(email: T): T {
    return (email ? email.trim().toLowerCase() : email) as T;
  }

  async findByEmail(email: string, organizationId?: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        ...UsersRepository.emailWhere(email),
        ...(organizationId ? { organizationId } : {}),
      },
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  async findByPhone(phone: string, organizationId?: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findFirst({
      where: { phone, ...(organizationId ? { organizationId } : {}) },
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  async findByIdentifier(identifier: string): Promise<UserEntity | null> {
    const isEmail = identifier.includes('@');
    const user = await this.prisma.user.findFirst({
      where: isEmail
        ? UsersRepository.emailWhere(identifier)
        : { phone: identifier.trim() },
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  async create(data: {
    name: string;
    email?: string;
    phone?: string;
    passwordHash?: string;
    role: UserRole;
    gender?: string;
    age?: number;
    organizationId?: string;
    loginPreference?: string;
  }): Promise<UserEntity> {
    const user = await this.prisma.user.create({
      data: { ...data, email: UsersRepository.normalizeEmail(data.email) },
      include: this.memberInclude,
    });
    return this.buildEntityFromInclude(user);
  }

  async update(id: string, data: Partial<{
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    gender: string;
    age: number;
    avatarUrl: string;
    isVacationMode: boolean;
    isDefaultAttendance: boolean;
    remindersEnabled: boolean;
    loginPreference: string;
    fcmToken: string;
    lastLoginAt: Date;
    isActive: boolean;
    organizationId: string;
    emailVerifiedAt: Date;
  }>): Promise<UserEntity> {
    const user = await this.prisma.user.update({
      where: { id },
      data:
        data.email !== undefined
          ? { ...data, email: UsersRepository.normalizeEmail(data.email) }
          : data,
      include: this.memberInclude,
    });
    return this.buildEntityFromInclude(user);
  }

  async existsByEmail(email: string, organizationId?: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: {
        ...UsersRepository.emailWhere(email),
        ...(organizationId ? { organizationId } : {}),
      },
    });
    return count > 0;
  }

  async existsByPhone(phone: string, organizationId?: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: { phone, ...(organizationId ? { organizationId } : {}) },
    });
    return count > 0;
  }

  /**
   * findByOrg — single query with include (no N+1).
   * For 1000 users this was previously 1001 queries; now it is 1 query + 1 join.
   */
  async findByOrg(organizationId: string, skip: number, limit: number): Promise<UserEntity[]> {
    const users = await this.prisma.user.findMany({
      where: { organizationId, isActive: true },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: this.memberInclude,
    });
    return users.map((u) => this.buildEntityFromInclude(u));
  }

  async countByOrg(organizationId: string): Promise<number> {
    return this.prisma.user.count({ where: { organizationId, isActive: true } });
  }

  // ── Pass 14 (FR-DEL-011 / FR-DLC-002/003, LOOP-080, SC-082) ────────────────

  /** Auth-sensitive fields for the account-deletion password check. */
  async findAuthById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        organizationId: true,
        passwordHash: true,
        avatarUrl: true,
        isActive: true,
        name: true,
      },
    });
  }

  /**
   * The full account-deletion transaction — revoke, soft-remove, anonymize.
   * The user ROW is retained so attendance/billing/audit foreign keys stay
   * intact (financial integrity, LOOP-080); only PII is erased in place.
   */
  async deleteAccount(userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      // 1. Revoke every session on every device (all token families).
      this.prisma.refreshToken.updateMany({
        where: { userId, isRevoked: false },
        data: { isRevoked: true },
      }),
      // 2. Soft-remove all group memberships (rows retained for history).
      this.prisma.groupMember.updateMany({
        where: { userId, status: 'active' },
        data: { status: 'removed', removedAt: now, removedBy: userId },
      }),
      // 3. Anonymize PII in place. Email stays unique per org via a
      //    deterministic placeholder; phone null clears the unique slot.
      this.prisma.user.update({
        where: { id: userId },
        data: {
          name: 'Deleted User',
          email: `deleted-${userId}@anonymized.invalid`,
          phone: null,
          avatarUrl: null,
          fcmToken: null,
          passwordHash: null,
          gender: null,
          age: null,
          isActive: false,
          deletedAt: now,
        } as any,
      }),
    ]);
  }

  /**
   * REQ (delete → smooth re-create): when the LAST active member of an
   * organization deletes their account, the org's name/slug would otherwise
   * stay locked forever and block the founder from ever re-registering the
   * same organization name (409 slug conflict on admin signup). Archive-rename
   * the now-empty org so the name becomes available again. Groups, billing
   * and audit history are untouched — only the org's display name and slug
   * change. Best-effort: account deletion must never fail because of this.
   */
  async archiveOrganizationIfEmpty(organizationId: string): Promise<void> {
    try {
      const remaining = await this.prisma.user.count({
        where: { organizationId, isActive: true },
      });
      if (remaining > 0) return;
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, slug: true },
      });
      if (!org || org.slug.includes('-archived-')) return;
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: {
          name: `${org.name} (archived)`,
          slug: `${org.slug}-archived-${Date.now()}`,
        },
      });
    } catch {
      /* best-effort — never blocks the deletion that triggered it */
    }
  }
}
