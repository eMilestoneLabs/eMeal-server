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
      startSlotKey: raw.startSlotKey ?? null,
      endSlotKey: raw.endSlotKey ?? null,
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
    startSlotKey: string | null;
    endSlotKey: string | null;
    reason: string | null;
  }): Promise<VacationRequestEntity> {
    const raw = await (this.prisma as any).vacationRequest.create({
      data: { ...data, status: 'pending' },
    });
    return this.toEntity(raw);
  }

  /**
   * FR-VACX-001 (Pass 11): overlapping pending/approved request for the same
   * member (same group scope, or either side org-level) — reject-on-overlap
   * policy, so ranges never double-govern a date.
   */
  async findOverlapping(
    userId: string,
    organizationId: string,
    groupId: string | null,
    startDate: Date,
    endDate: Date,
  ): Promise<VacationRequestEntity | null> {
    const raw = await (this.prisma as any).vacationRequest.findFirst({
      where: {
        organizationId,
        userId,
        deletedAt: null,
        status: { in: ['pending', 'approved'] },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
        ...(groupId ? { OR: [{ groupId }, { groupId: null }] } : {}),
      },
    });
    return raw ? this.toEntity(raw) : null;
  }

  /** Org timezone for TZ-correct business-day math (FR-VACX-006). */
  async getOrgTimezone(organizationId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

  /**
   * FR-VACX-004 (LOOP-046): explicit Present marks overlapping a vacation
   * range. Policy = keep the explicit Present (member action is never
   * silently discarded); the conflict is surfaced to admin + member.
   */
  async findPresentConflicts(
    userId: string,
    organizationId: string,
    groupId: string | null,
    startDate: Date,
    endDate: Date,
  ): Promise<Array<{ date: string; mealId: string; mealName: string }>> {
    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        organizationId,
        userId,
        status: 'present',
        attendanceDate: { gte: startDate, lte: endDate },
        ...(groupId ? { groupId } : {}),
      },
      select: {
        attendanceDate: true,
        mealId: true,
        meal: { select: { displayName: true, name: true } },
      },
      orderBy: { attendanceDate: 'asc' },
      take: 50,
    });
    return rows.map((r) => ({
      date: r.attendanceDate.toISOString().slice(0, 10),
      mealId: r.mealId,
      mealName: r.meal?.displayName || r.meal?.name || r.mealId,
    }));
  }

  /**
   * FR-VACX-006: does any OTHER approved request still cover [todayUtc]?
   * Used on approve/cancel so the isVacationMode flag always mirrors the
   * request set, TZ-correct.
   */
  async hasApprovedCovering(
    userId: string,
    organizationId: string,
    todayUtc: Date,
    excludeId?: string,
  ): Promise<boolean> {
    const hit = await (this.prisma as any).vacationRequest.findFirst({
      where: {
        organizationId,
        userId,
        status: 'approved',
        deletedAt: null,
        startDate: { lte: todayUtc },
        endDate: { gte: todayUtc },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    return !!hit;
  }

  /** fcmToken lookup for fire-and-forget member notifications (FR-VACX-007). */
  async getUserPush(
    userId: string,
  ): Promise<{ userId: string; fcmToken: string } | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true },
    });
    return u?.fcmToken ? { userId, fcmToken: u.fcmToken } : null;
  }

  async findById(
    id: string,
    organizationId: string,
  ): Promise<VacationRequestEntity | null> {
    const raw = await (this.prisma as any).vacationRequest.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!raw) return null;
    // FR-NAME-001 (ISSUE-3): prefer the canonical User.name at read time.
    const canonical = await this.getUserName(raw.userId);
    return this.toEntity({ ...raw, userName: canonical ?? raw.userName });
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
        // FR-SORT-001 (ISSUE-12): latest first with a stable secondary key.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: opts.limit,
      }),
      (this.prisma as any).vacationRequest.count({ where }),
    ]);
    // FR-NAME-001 (ISSUE-3): member-facing names resolve from the canonical
    // User.name at read time — the denormalised userName column is only a
    // fallback for users that no longer exist. One indexed batch query per page.
    const nameById = await this.canonicalNames(rows.map((r: any) => r.userId));
    return {
      data: rows.map((r: any) =>
        this.toEntity({
          ...r,
          userName: nameById.get(r.userId) ?? r.userName,
        }),
      ),
      total,
    };
  }

  /** Batch-resolve canonical user names (FR-NAME-001). Empty input → empty map. */
  private async canonicalNames(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const map = new Map<string, string>();
    for (const u of users) {
      if (u.name && u.name.trim().length > 0) map.set(u.id, u.name);
    }
    return map;
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
