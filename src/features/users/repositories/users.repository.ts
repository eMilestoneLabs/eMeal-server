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

  async findByEmail(email: string, organizationId?: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findFirst({
      where: { email, ...(organizationId ? { organizationId } : {}) },
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
      where: isEmail ? { email: identifier } : { phone: identifier },
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
      data,
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
      data,
      include: this.memberInclude,
    });
    return this.buildEntityFromInclude(user);
  }

  async existsByEmail(email: string, organizationId?: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: { email, ...(organizationId ? { organizationId } : {}) },
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
}
