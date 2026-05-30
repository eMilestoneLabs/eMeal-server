import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { UserEntity } from '../entities/user.entity';
import { UserRole } from '@prisma/client';

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build UserEntity from Prisma User record + computed groupIds.
   * groupIds are computed from GroupMember table — not a DB column.
   */
  private async buildEntity(user: any): Promise<UserEntity> {
    // status: 'active' — blocked/removed members do not appear in groupIds
    const members = await this.prisma.groupMember.findMany({
      where: { userId: user.id, status: 'active' },
      select: { groupId: true },
    });
    const groupIds = members.map((m) => m.groupId);
    return new UserEntity({
      ...user,
      groupIds,
      groupId: groupIds[0] ?? null,
    });
  }

  async findById(id: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return null;
    return this.buildEntity(user);
  }

  async findByEmail(email: string, organizationId?: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        email,
        ...(organizationId ? { organizationId } : {}),
      },
    });
    if (!user) return null;
    return this.buildEntity(user);
  }

  async findByPhone(phone: string, organizationId?: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        phone,
        ...(organizationId ? { organizationId } : {}),
      },
    });
    if (!user) return null;
    return this.buildEntity(user);
  }

  async findByIdentifier(identifier: string): Promise<UserEntity | null> {
    const isEmail = identifier.includes('@');
    const user = await this.prisma.user.findFirst({
      where: isEmail ? { email: identifier } : { phone: identifier },
    });
    if (!user) return null;
    return this.buildEntity(user);
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
    const user = await this.prisma.user.create({ data });
    return this.buildEntity(user);
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
  }>): Promise<UserEntity> {
    const user = await this.prisma.user.update({ where: { id }, data });
    return this.buildEntity(user);
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
}
