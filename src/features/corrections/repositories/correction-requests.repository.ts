import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CorrectionRequestEntity } from '../entities/correction-request.entity';

/**
 * CorrectionRequestsRepository — Prisma access for AttendanceCorrectionRequest
 * (Module 33, FR-ACR-*). Strictly org-scoped: organizationId always supplied
 * by the service from the JWT, never from the client.
 *
 * Names and meal labels are resolved from the canonical rows at read time
 * (FR-NAME-001) via one batched query per page — never denormalised copies.
 */
@Injectable()
export class CorrectionRequestsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any): CorrectionRequestEntity {
    return new CorrectionRequestEntity({
      id: raw.id,
      organizationId: raw.organizationId,
      groupId: raw.groupId,
      userId: raw.userId,
      userName: raw.userName ?? null,
      mealId: raw.mealId,
      mealName: raw.mealName ?? null,
      attendanceDate: raw.attendanceDate,
      requestType: raw.requestType,
      requestedStatus: raw.requestedStatus ?? null,
      requestedPreference: raw.requestedPreference ?? null,
      reason: raw.reason ?? null,
      evidenceUrl: raw.evidenceUrl ?? null,
      status: raw.status,
      reviewedBy: raw.reviewedBy ?? null,
      reviewedAt: raw.reviewedAt ?? null,
      reviewNote: raw.reviewNote ?? null,
      sourceChannel: raw.sourceChannel ?? 'member',
      resultRecordId: raw.resultRecordId ?? null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      expiresAt: raw.expiresAt,
    });
  }

  /** Batch-resolve canonical user names + meal labels for a page of rows. */
  private async decorate(rows: any[]): Promise<CorrectionRequestEntity[]> {
    if (rows.length === 0) return [];
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const mealIds = [...new Set(rows.map((r) => r.mealId))];
    const [users, meals] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      }),
      this.prisma.meal.findMany({
        where: { id: { in: mealIds } },
        select: { id: true, name: true, displayName: true },
      }),
    ]);
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const mealById = new Map(
      meals.map((m) => [m.id, m.displayName ?? m.name]),
    );
    return rows.map((r) =>
      this.toEntity({
        ...r,
        userName: nameById.get(r.userId) ?? null,
        mealName: mealById.get(r.mealId) ?? null,
      }),
    );
  }

  async create(data: {
    organizationId: string;
    groupId: string;
    userId: string;
    mealId: string;
    attendanceDate: Date;
    requestType: string;
    requestedStatus: string | null;
    requestedPreference: string | null;
    reason: string | null;
    evidenceUrl: string | null;
    sourceChannel: string;
    reviewedBy?: string | null; // proposing admin for admin_prompt confirmations
    expiresAt: Date;
  }): Promise<CorrectionRequestEntity> {
    const raw = await this.prisma.attendanceCorrectionRequest.create({
      data: { ...data, status: 'pending' },
    });
    const [entity] = await this.decorate([raw]);
    return entity;
  }

  async findById(
    id: string,
    organizationId: string,
  ): Promise<CorrectionRequestEntity | null> {
    const raw = await this.prisma.attendanceCorrectionRequest.findFirst({
      where: { id, organizationId },
    });
    if (!raw) return null;
    const [entity] = await this.decorate([raw]);
    return entity;
  }

  async list(
    organizationId: string,
    opts: {
      userId?: string;
      groupId?: string;
      status?: string;
      sourceChannel?: string;
      page: number;
      limit: number;
    },
  ): Promise<{ data: CorrectionRequestEntity[]; total: number }> {
    const where: any = { organizationId };
    if (opts.userId) where.userId = opts.userId;
    if (opts.groupId) where.groupId = opts.groupId;
    if (opts.status) where.status = opts.status;
    if (opts.sourceChannel) where.sourceChannel = opts.sourceChannel;
    const skip = (opts.page - 1) * opts.limit;
    const [rows, total] = await Promise.all([
      this.prisma.attendanceCorrectionRequest.findMany({
        where,
        // FR-SORT-001: latest first with a stable secondary key.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: opts.limit,
      }),
      this.prisma.attendanceCorrectionRequest.count({ where }),
    ]);
    return { data: await this.decorate(rows), total };
  }

  /** One open request per (member, meal, date) — FR-ACR-020. */
  async findOpenDuplicate(
    organizationId: string,
    userId: string,
    mealId: string,
    attendanceDate: Date,
  ): Promise<boolean> {
    const count = await this.prisma.attendanceCorrectionRequest.count({
      where: {
        organizationId,
        userId,
        mealId,
        attendanceDate,
        status: 'pending',
      },
    });
    return count > 0;
  }

  /** Open (pending) member-raised requests for the rate limit (FR-ACR-020). */
  async countOpenForUser(
    organizationId: string,
    userId: string,
  ): Promise<number> {
    return this.prisma.attendanceCorrectionRequest.count({
      where: {
        organizationId,
        userId,
        status: 'pending',
        sourceChannel: 'member',
      },
    });
  }

  /** Requests created since [since] for the per-day rate limit (FR-ACR-020). */
  async countCreatedSince(
    organizationId: string,
    userId: string,
    since: Date,
  ): Promise<number> {
    return this.prisma.attendanceCorrectionRequest.count({
      where: {
        organizationId,
        userId,
        sourceChannel: 'member',
        createdAt: { gte: since },
      },
    });
  }

  async updateStatus(
    id: string,
    organizationId: string,
    data: {
      status: string;
      reviewedBy?: string | null;
      reviewedAt?: Date | null;
      reviewNote?: string | null;
      resultRecordId?: string | null;
    },
  ): Promise<CorrectionRequestEntity> {
    await this.prisma.attendanceCorrectionRequest.updateMany({
      where: { id, organizationId },
      data,
    });
    return (await this.findById(id, organizationId))!;
  }

  /**
   * FR-ACR-011 lazy expiry sweep: mark every overdue pending request expired.
   * Runs on each list/review touch (one cheap indexed updateMany — uses the
   * (status, expiresAt) index) so no new scheduler/infra is required.
   */
  async expireDue(organizationId: string): Promise<number> {
    const result = await this.prisma.attendanceCorrectionRequest.updateMany({
      where: {
        organizationId,
        status: 'pending',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired' },
    });
    return result.count;
  }
}
