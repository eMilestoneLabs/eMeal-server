import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { UserEntity } from '../entities/user.entity';
import { UserRole } from '@prisma/client';

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
   * Additive: auto-deactivate vacation mode when no approved request still
   * covers today (the vacation has expired). Called on read (e.g. GET /auth/me)
   * so the flag turns OFF without an app restart or a scheduled job. No-op when
   * vacation is already off or an approved request still covers today (inclusive).
   */
  async syncVacationExpiry(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isVacationMode: true },
    });
    if (!user || !user.isVacationMode) return;

    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    // endDate is inclusive (stored at UTC midnight) — still covered while
    // endDate >= today.
    const active = await this.prisma.vacationRequest.findFirst({
      where: { userId, status: 'approved', endDate: { gte: todayUtc } },
      select: { id: true },
    });
    if (!active) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { isVacationMode: false },
      });
    }
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
