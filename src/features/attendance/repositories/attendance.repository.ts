import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AttendanceEntity,
  AttendanceSummaryEntity,
  MealAttendanceSummaryEntity,
} from '../entities/attendance.entity';

/**
 * AttendanceRepository — all DB operations are org-scoped.
 *
 * CRITICAL rules enforced here:
 *   - organizationId always applied from service (never from client)
 *   - upsert on @@unique([userId, mealId, attendanceDate]) = idempotent marking
 *   - findByUser/Group always scoped by organizationId
 *   - softDelete NOT applicable — attendance is updated, never hidden
 */
@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Prisma → Entity mapping ──────────────────────────────────────────────

  private toEntity(record: any): AttendanceEntity {
    return new AttendanceEntity({
      id: record.id,
      organizationId: record.organizationId,
      groupId: record.groupId,
      userId: record.userId,
      mealId: record.mealId,
      attendanceDate: record.attendanceDate,
      status: record.status,
      preference: record.preference ?? null,
      note: record.note ?? null,
      markedAt: record.markedAt ?? null,
      markedBy: record.markedBy ?? null,
      price: record.price ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      meal: record.meal
        ? {
            slotKey: record.meal.slotKey,
            name: record.meal.name,
            displayName: record.meal.displayName ?? null,
            attendanceWindowOpen: record.meal.attendanceWindowOpen ?? null,
            attendanceWindowClose: record.meal.attendanceWindowClose ?? null,
          }
        : null,
      user: record.user
        ? {
            id: record.user.id,
            name: record.user.name,
            email: record.user.email ?? null,
            phone: record.user.phone ?? null,
            avatarUrl: record.user.avatarUrl ?? null,
          }
        : null,
    });
  }

  private get mealInclude() {
    return {
      meal: {
        select: {
          slotKey: true,
          name: true,
          displayName: true,
          attendanceWindowOpen: true,
          attendanceWindowClose: true,
        },
      },
    };
  }

  // ── Upsert — idempotent attendance marking ───────────────────────────────

  /**
   * Upsert attendance for a user/meal/date.
   * Uses @@unique([userId, mealId, attendanceDate]) as the conflict key.
   * Safe to call multiple times — updates existing record if duplicate.
   */
  async upsert(data: {
    organizationId: string;
    groupId: string;
    userId: string;
    mealId: string;
    attendanceDate: Date;
    status: string;
    preference?: string | null;
    note?: string | null;
    markedAt?: Date | null;
    markedBy?: string | null;
    price?: number | null;
  }): Promise<AttendanceEntity> {
    const record = await this.prisma.attendanceRecord.upsert({
      where: {
        userId_mealId_attendanceDate: {
          userId: data.userId,
          mealId: data.mealId,
          attendanceDate: data.attendanceDate,
        },
      },
      create: {
        organizationId: data.organizationId,
        groupId: data.groupId,
        userId: data.userId,
        mealId: data.mealId,
        attendanceDate: data.attendanceDate,
        status: data.status as any,
        preference: data.preference ?? null,
        note: data.note ?? null,
        markedAt: data.markedAt ?? new Date(),
        markedBy: data.markedBy ?? null,
        price: data.price ?? null,
      },
      update: {
        status: data.status as any,
        // Issue 1 (preference preservation): a status-only re-mark or an admin
        // override that omits `preference` must NOT erase a previously recorded
        // preference. Without this guard, toggling status or overriding a member
        // nulled their stored preference, so it vanished from the dashboard
        // preference breakdown. A genuine new preference still overwrites; a
        // null/undefined value leaves the existing one intact.
        ...(data.preference != null ? { preference: data.preference } : {}),
        note: data.note ?? null,
        markedAt: data.markedAt ?? new Date(),
        markedBy: data.markedBy ?? null,
        price: data.price ?? null,
      },
      include: this.mealInclude,
    });

    return this.toEntity(record);
  }

  // ── Find by ID ────────────────────────────────────────────────────────────

  async findById(
    id: string,
    organizationId: string,
  ): Promise<AttendanceEntity | null> {
    const record = await this.prisma.attendanceRecord.findFirst({
      where: { id, organizationId },
      include: this.mealInclude,
    });
    return record ? this.toEntity(record) : null;
  }

  // ── Find specific record (for idempotency check in service) ──────────────

  async findByKey(
    userId: string,
    mealId: string,
    attendanceDate: Date,
    organizationId: string,
  ): Promise<AttendanceEntity | null> {
    const record = await this.prisma.attendanceRecord.findFirst({
      where: { userId, mealId, attendanceDate, organizationId },
      include: this.mealInclude,
    });
    return record ? this.toEntity(record) : null;
  }

  // ── Find by user — paginated ──────────────────────────────────────────────

  async findByUser(
    userId: string,
    organizationId: string,
    filters: {
      groupId?: string;
      mealId?: string;
      fromDate?: Date;
      toDate?: Date;
      status?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{ data: AttendanceEntity[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { userId, organizationId };
    if (filters.groupId) where.groupId = filters.groupId;
    if (filters.mealId) where.mealId = filters.mealId;
    if (filters.status) where.status = filters.status;
    if (filters.fromDate || filters.toDate) {
      where.attendanceDate = {};
      if (filters.fromDate) where.attendanceDate.gte = filters.fromDate;
      if (filters.toDate) where.attendanceDate.lte = filters.toDate;
    }

    const [records, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        include: this.mealInclude,
        orderBy: { attendanceDate: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return {
      data: records.map((r) => this.toEntity(r)),
      total,
      page,
      limit,
    };
  }

  // ── Find by group — paginated (admin view) ────────────────────────────────

  async findByGroup(
    groupId: string,
    organizationId: string,
    filters: {
      mealId?: string;
      userId?: string;
      fromDate?: Date;
      toDate?: Date;
      status?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{ data: AttendanceEntity[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const skip = (page - 1) * limit;

    const where: any = { groupId, organizationId };
    if (filters.mealId) where.mealId = filters.mealId;
    if (filters.userId) where.userId = filters.userId;
    if (filters.status) where.status = filters.status;
    if (filters.fromDate || filters.toDate) {
      where.attendanceDate = {};
      if (filters.fromDate) where.attendanceDate.gte = filters.fromDate;
      if (filters.toDate) where.attendanceDate.lte = filters.toDate;
    }

    const [records, total] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where,
        include: {
          ...this.mealInclude,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: [{ attendanceDate: 'desc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return {
      data: records.map((r) => this.toEntity(r)),
      total,
      page,
      limit,
    };
  }

  // ── Attendance summary — aggregate counts (NO rates) ─────────────────────

  /**
   * Aggregate attendance counts for a user in a group over a date range.
   * CRITICAL: Returns raw counts only. Flutter computes rates/percentages.
   */
  async getUserSummary(
    userId: string,
    groupId: string,
    organizationId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<{
    presentCount: number;
    absentCount: number;
    skippedCount: number;
    onVacationCount: number;
    totalDays: number;
  }> {
    const grouped = await this.prisma.attendanceRecord.groupBy({
      by: ['status'],
      where: {
        userId,
        groupId,
        organizationId,
        attendanceDate: { gte: fromDate, lte: toDate },
      },
      _count: { status: true },
    });

    const counts = {
      present: 0,
      absent: 0,
      skipped: 0,
      onVacation: 0,
    };

    for (const row of grouped) {
      const s = row.status as string;
      if (s === 'present') counts.present = row._count.status;
      else if (s === 'absent') counts.absent = row._count.status;
      else if (s === 'skipped') counts.skipped = row._count.status;
      else if (s === 'onVacation') counts.onVacation = row._count.status;
    }

    const total = counts.present + counts.absent + counts.skipped + counts.onVacation;

    return {
      presentCount: counts.present,
      absentCount: counts.absent,
      skippedCount: counts.skipped,
      onVacationCount: counts.onVacation,
      totalDays: total,
    };
  }

  // ── Meal attendance summary — per-meal aggregate (admin dashboard) ────────

  async getMealSummary(
    mealId: string,
    organizationId: string,
    attendanceDate: Date,
  ): Promise<{
    presentCount: number;
    absentCount: number;
    skippedCount: number;
    snapshotPrice: number | null;
    preferenceBreakdown: Record<string, number>;
  }> {
    const [statusGroups, prefGroups, priceGroups] = await Promise.all([
      this.prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: { mealId, organizationId, attendanceDate },
        _count: { status: true },
      }),
      this.prisma.attendanceRecord.groupBy({
        by: ['preference'],
        where: {
          mealId,
          organizationId,
          attendanceDate,
          preference: { not: null },
          status: 'present',
        },
        _count: { preference: true },
      }),
      // Issue 1: snapshot unit price actually billed for this meal+date.
      // Group present records by their captured price snapshot so the admin
      // dashboard never shows a later-edited (live) Meal.price for a closed day.
      this.prisma.attendanceRecord.groupBy({
        by: ['price'],
        where: {
          mealId,
          organizationId,
          attendanceDate,
          status: 'present',
          price: { not: null },
        },
        _count: { price: true },
      }),
    ]);

    const statusCounts = { present: 0, absent: 0, skipped: 0 };
    for (const row of statusGroups) {
      const s = row.status as string;
      if (s === 'present') statusCounts.present = row._count.status;
      else if (s === 'absent') statusCounts.absent = row._count.status;
      else if (s === 'skipped') statusCounts.skipped = row._count.status;
    }

    const preferenceBreakdown: Record<string, number> = {};
    for (const row of prefGroups) {
      if (row.preference) {
        preferenceBreakdown[row.preference] = row._count.preference;
      }
    }

    // Pick the most common snapshot price among present records (mode). Within a
    // closed window snapshots are uniform; if mixed (edited mid-window) the
    // dominant price wins, the higher price breaking ties.
    let snapshotPrice: number | null = null;
    let bestCount = -1;
    for (const row of priceGroups) {
      if (row.price == null) continue;
      const c = row._count.price;
      if (c > bestCount || (c === bestCount && row.price > (snapshotPrice ?? 0))) {
        bestCount = c;
        snapshotPrice = row.price;
      }
    }

    return {
      presentCount: statusCounts.present,
      absentCount: statusCounts.absent,
      skippedCount: statusCounts.skipped,
      snapshotPrice,
      preferenceBreakdown,
    };
  }

  // ── Bulk upsert — transactional ───────────────────────────────────────────

  /**
   * Upsert multiple attendance records in a single transaction.
   * Each entry is idempotent — safe to retry.
   */
  async bulkUpsert(
    entries: Array<{
      organizationId: string;
      groupId: string;
      userId: string;
      mealId: string;
      attendanceDate: Date;
      status: string;
      preference?: string | null;
      note?: string | null;
      markedAt?: Date;
      markedBy?: string | null;
      price?: number | null;
    }>,
  ): Promise<AttendanceEntity[]> {
    const now = new Date();

    const results = await this.prisma.$transaction(
      entries.map((e) =>
        this.prisma.attendanceRecord.upsert({
          where: {
            userId_mealId_attendanceDate: {
              userId: e.userId,
              mealId: e.mealId,
              attendanceDate: e.attendanceDate,
            },
          },
          create: {
            organizationId: e.organizationId,
            groupId: e.groupId,
            userId: e.userId,
            mealId: e.mealId,
            attendanceDate: e.attendanceDate,
            status: e.status as any,
            preference: e.preference ?? null,
            note: e.note ?? null,
            markedAt: e.markedAt ?? now,
            markedBy: e.markedBy ?? null,
            price: e.price ?? null,
          },
          update: {
            status: e.status as any,
            preference: e.preference ?? null,
            note: e.note ?? null,
            markedAt: e.markedAt ?? now,
            markedBy: e.markedBy ?? null,
            price: e.price ?? null,
          },
          include: this.mealInclude,
        }),
      ),
    );

    return results.map((r) => this.toEntity(r));
  }

  // ── Billing aggregation data (Member Billing V2) ──────────────────────────

  /**
   * Raw data for group-wide billing aggregation: active members (with role)
   * plus every attendance record in [fromDate, toDate]. The service aggregates
   * these into summary / meal breakdown / per-member figures. Org-scoped and
   * NOT capped (accurate for any group size). Revenue is computed from the
   * per-record price SNAPSHOT, so historical bills never recalculate.
   */
  async getBillingData(
    groupId: string,
    organizationId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<{
    members: Array<{
      userId: string;
      name: string;
      role: string;
      email: string | null;
      phone: string | null;
    }>;
    records: Array<{
      userId: string;
      mealId: string;
      mealName: string;
      status: string;
      price: number | null;
      markedAt: Date | null;
      attendanceDate: Date;
    }>;
  }> {
    const [members, records] = await Promise.all([
      this.prisma.groupMember.findMany({
        where: { groupId, status: 'active' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              role: true,
              email: true,
              phone: true,
            },
          },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: {
          groupId,
          organizationId,
          attendanceDate: { gte: fromDate, lte: toDate },
        },
        select: {
          userId: true,
          mealId: true,
          status: true,
          price: true,
          markedAt: true,
          attendanceDate: true,
          meal: { select: { name: true, displayName: true } },
        },
      }),
    ]);

    return {
      members: members.map((m) => ({
        userId: m.userId,
        name: m.user?.name ?? m.userId,
        role: (m.functionalRole ?? m.user?.role ?? 'member') as string,
        email: m.user?.email ?? null,
        phone: m.user?.phone ?? null,
      })),
      records: records.map((r) => ({
        userId: r.userId,
        mealId: r.mealId,
        mealName: r.meal?.displayName ?? r.meal?.name ?? '—',
        status: r.status as string,
        price: r.price ?? null,
        markedAt: r.markedAt ?? null,
        attendanceDate: r.attendanceDate,
      })),
    };
  }
}
