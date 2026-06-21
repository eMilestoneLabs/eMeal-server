import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { VacationRequestEntity } from '../entities/vacation-request.entity';

/**
 * VacationRequestsRepository — Prisma access for VacationRequest. Strictly
 * org-scoped (organizationId always supplied by the service from the JWT).
 */
@Injectable()
export class VacationRequestsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any): VacationRequestEntity {
    return new VacationRequestEntity({
      id: raw.id,
      organizationId: raw.organizationId,
      groupId: raw.groupId ?? null,
      userId: raw.userId,
      userName: raw.userName ?? null,
      startDate: raw.startDate,
      endDate: raw.endDate,
      reason: raw.reason ?? null,
      status: raw.status,
      reviewedBy: raw.reviewedBy ?? null,
      reviewedAt: raw.reviewedAt ?? null,
      reviewNote: raw.reviewNote ?? null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  async getUserName(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return u?.name ?? null;
  }

  async create(data: {
    organizationId: string;
    groupId: string | null;
    userId: string;
    userName: string | null;
    startDate: Date;
    endDate: Date;
    reason: string | null;
  }): Promise<VacationRequestEntity> {
    const raw = await (this.prisma as any).vacationRequest.create({
      data: { ...data, status: 'pending' },
    });
    return this.toEntity(raw);
  }

  async findById(
    id: string,
    organizationId: string,
  ): Promise<VacationRequestEntity | null> {
    const raw = await (this.prisma as any).vacationRequest.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    return raw ? this.toEntity(raw) : null;
  }

  async list(
    organizationId: string,
    opts: {
      userId?: string;
      groupId?: string;
      status?: string;
      page: number;
      limit: number;
    },
  ): Promise<{ data: VacationRequestEntity[]; total: number }> {
    const where: any = { organizationId, deletedAt: null };
    if (opts.userId) where.userId = opts.userId;
    if (opts.groupId) where.groupId = opts.groupId;
    if (opts.status) where.status = opts.status;
    const skip = (opts.page - 1) * opts.limit;
    const [rows, total] = await Promise.all([
      (this.prisma as any).vacationRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take: opts.limit,
      }),
      (this.prisma as any).vacationRequest.count({ where }),
    ]);
    return { data: rows.map((r: any) => this.toEntity(r)), total };
  }

  async updateStatus(
    id: string,
    organizationId: string,
    data: {
      status: string;
      reviewedBy?: string | null;
      reviewedAt?: Date | null;
      reviewNote?: string | null;
    },
  ): Promise<VacationRequestEntity> {
    await (this.prisma as any).vacationRequest.updateMany({
      where: { id, organizationId },
      data,
    });
    return this.findById(id, organizationId) as Promise<VacationRequestEntity>;
  }

  /** Additive integration with the existing self-service vacation flag. */
  async setUserVacation(
    userId: string,
    organizationId: string,
    isVacationMode: boolean,
  ): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, organizationId },
      data: { isVacationMode },
    });
  }
}
