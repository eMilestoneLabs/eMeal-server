import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizePreferenceKey } from '../../../common/utils/system-none.util';
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
      preferences: record.preferences ?? null,
      note: record.note ?? null,
      markedAt: record.markedAt ?? null,
      markedBy: record.markedBy ?? null,
      price: record.price ?? null,
      billAbsent: record.billAbsent ?? null,
      source: record.source ?? null,
      sourceRequestId: record.sourceRequestId ?? null,
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
        ? ({
            id: record.user.id,
            name: record.user.name,
            email: record.user.email ?? null,
            phone: record.user.phone ?? null,
            avatarUrl: record.user.avatarUrl ?? null,
            // Live-Test-9 ISSUE-4.5 (additive): rides only when the query
            // selected it — admin roster ordering (Admin/Manager first).
            role: record.user.role ?? null,
          } as any)
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
    // Live-Test-11 ISSUE-017: Bill-Absent policy snapshot (absent writes only;
    // omitted = leave existing value untouched).
    billAbsent?: boolean | null;
    // Module 33 consent trail — omitted = leave existing / default 'self'.
    source?: string | null;
    sourceRequestId?: string | null;
    // Module 36 (FR-PG-013) — omitted = legacy path, selections untouched.
    // Provided (possibly empty) = replace the JSON snapshot + child rows.
    preferences?: Array<Record<string, unknown>> | null;
    selectionRows?: Array<{
      preferenceGroupId: string;
      groupLabelSnapshot: string;
      optionKey: string;
      optionLabelSnapshot: string;
      isVegSnapshot: boolean;
      priceDeltaSnapshot: number;
      quantity: number;
    }>;
  }): Promise<AttendanceEntity> {
    // Module 36: when a selection set travels with the mark, the record upsert
    // and its child rows must land atomically (FAIL_SAFE/data integrity).
    if (data.selectionRows !== undefined) {
      return this.upsertWithSelections(data as any);
    }
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
        ...(data.billAbsent !== undefined ? { billAbsent: data.billAbsent } : {}),
        ...(data.source !== undefined ? { source: data.source } : {}),
        ...(data.sourceRequestId !== undefined
          ? { sourceRequestId: data.sourceRequestId }
          : {}),
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
        ...(data.billAbsent !== undefined ? { billAbsent: data.billAbsent } : {}),
        ...(data.source !== undefined ? { source: data.source } : {}),
        ...(data.sourceRequestId !== undefined
          ? { sourceRequestId: data.sourceRequestId }
          : {}),
      },
      include: this.mealInclude,
    });

    return this.toEntity(record);
  }

  /**
   * Module 36 (FR-PG-013): upsert record + replace its selection child rows
   * atomically. JSON snapshot and rows always move together — a crash between
   * the two can never leave a half-written selection.
   */
  private async upsertWithSelections(data: {
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
    billAbsent?: boolean | null;
    source?: string | null;
    sourceRequestId?: string | null;
    preferences?: Array<Record<string, unknown>> | null;
    selectionRows: Array<{
      preferenceGroupId: string;
      groupLabelSnapshot: string;
      optionKey: string;
      optionLabelSnapshot: string;
      isVegSnapshot: boolean;
      priceDeltaSnapshot: number;
      quantity: number;
    }>;
  }): Promise<AttendanceEntity> {
    const prefJson =
      data.preferences && data.preferences.length > 0
        ? (data.preferences as Prisma.InputJsonValue)
        : Prisma.DbNull;

    const record = await this.prisma.$transaction(async (tx) => {
      const rec = await tx.attendanceRecord.upsert({
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
          preferences: prefJson,
          note: data.note ?? null,
          markedAt: data.markedAt ?? new Date(),
          markedBy: data.markedBy ?? null,
          price: data.price ?? null,
          ...(data.billAbsent !== undefined
            ? { billAbsent: data.billAbsent }
            : {}),
          ...(data.source !== undefined ? { source: data.source } : {}),
          ...(data.sourceRequestId !== undefined
            ? { sourceRequestId: data.sourceRequestId }
            : {}),
        },
        update: {
          status: data.status as any,
          // Same preference-preservation guard as the legacy path (Issue 1).
          ...(data.preference != null ? { preference: data.preference } : {}),
          preferences: prefJson,
          note: data.note ?? null,
          markedAt: data.markedAt ?? new Date(),
          markedBy: data.markedBy ?? null,
          price: data.price ?? null,
          ...(data.billAbsent !== undefined
            ? { billAbsent: data.billAbsent }
            : {}),
          ...(data.source !== undefined ? { source: data.source } : {}),
          ...(data.sourceRequestId !== undefined
            ? { sourceRequestId: data.sourceRequestId }
            : {}),
        },
        include: this.mealInclude,
      });

      await tx.attendancePreferenceSelection.deleteMany({
        where: { attendanceRecordId: rec.id },
      });
      if (data.selectionRows.length > 0) {
        await tx.attendancePreferenceSelection.createMany({
          data: data.selectionRows.map((r) => ({
            ...r,
            attendanceRecordId: rec.id,
          })),
        });
      }
      return rec;
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

    // Perf (2026-07-19): the single-day shape (GET /attendance/today —
    // fromDate == toDate, limit 50) can never fill a page (records/day ≤
    // meals/day ≤ MMT cap 10), so its COUNT round trip is skipped when the
    // page under-fills; an under-filled page pins the exact total. Multi-day
    // history queries keep the legacy parallel findMany+COUNT — their first
    // page often fills, and a serial COUNT there would ADD latency.
    const singleDay =
      !!filters.fromDate &&
      !!filters.toDate &&
      filters.fromDate.getTime() === filters.toDate.getTime();

    const findArgs = {
      where,
      include: this.mealInclude,
      // FR-SORT-001 (ISSUE-12): latest first — newest date, then newest mark
      // within the day (unmarked/pending last), id as stable final key.
      orderBy: [
        { attendanceDate: 'desc' },
        { markedAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ],
      skip,
      take: limit,
    } as const;

    let records: any[];
    let total: number;
    if (singleDay) {
      records = await this.prisma.attendanceRecord.findMany(findArgs as any);
      const underfilled =
        records.length < limit && (skip === 0 || records.length > 0);
      total = underfilled
        ? skip + records.length
        : await this.prisma.attendanceRecord.count({ where });
    } else {
      [records, total] = await Promise.all([
        this.prisma.attendanceRecord.findMany(findArgs as any),
        this.prisma.attendanceRecord.count({ where }),
      ]);
    }

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
              // Live-Test-9 ISSUE-4.5: admin roster ordering — Admin/Manager
              // rows list first. Additive select; serializer emits userRole.
              role: true,
            },
          },
        },
        // FR-SORT-001 (ISSUE-12): latest first — newest date, then newest mark
        // within the day (unmarked/pending last), id as stable final key.
        orderBy: [
          { attendanceDate: 'desc' },
          { markedAt: { sort: 'desc', nulls: 'last' } },
          { id: 'desc' },
        ],
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
    /**
     * ISSUE-002 (Live-Test-13): true when this meal runs STANDALONE
     * preferences. Only then does a PRESENT record with no preference mean the
     * system None ("attending, no optional item") and get folded into the
     * hidden None tally. Defaults to false so every existing caller — and any
     * preference-free meal — keeps the exact previous behaviour (such rows
     * excluded), and no phantom preference section can appear.
     */
    preferencesActive = false,
  ): Promise<{
    presentCount: number;
    absentCount: number;
    skippedCount: number;
    snapshotPrice: number | null;
    preferenceBreakdown: Record<string, number>;
    preferenceGroupBreakdown: Record<string, Record<string, number>>;
    preferenceGroupPickCounts: Record<string, number>;
    /** ISSUE-006: snapshot label → stable preference-group id (rename-proof). */
    preferenceGroupIdByLabel: Record<string, string>;
    preferenceGroupRespondentCounts: Record<string, number>;
  }> {
    const [
      statusGroups,
      prefGroups,
      priceGroups,
      selectionGroups,
      respondentGroups,
    ] = await Promise.all([
      this.prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: { mealId, organizationId, attendanceDate },
        _count: { status: true },
      }),
      // ISSUE-002 (Live-Test-13): PRESENT records with NO preference are no
      // longer excluded — they are folded into the system None tally at read
      // time (see normalizePreferenceKey). Such rows come from legacy data,
      // imports, and guests booked while "Require a preference per guest" was
      // OFF; dropping them made (visible + None) fall short of Total Present,
      // which is what showed a permanent red "data mismatch" on the Kitchen
      // Summary. Stored rows are never modified. `_all` is required because
      // Prisma's per-field _count ignores NULLs — the exact reason the null
      // bucket would otherwise come back as 0.
      this.prisma.attendanceRecord.groupBy({
        by: ['preference'],
        where: {
          mealId,
          organizationId,
          attendanceDate,
          status: 'present',
          ...(preferencesActive ? {} : { preference: { not: null } }),
        },
        _count: { _all: true },
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
      // Module 36 (FR-PG-050): multi-preference-group selections of PRESENT
      // members, aggregated by snapshotted group + option labels so the admin
      // dashboard shows per-option plate counts (label snapshots are immutable
      // — later edits to a preference group never rewrite past summaries).
      this.prisma.attendancePreferenceSelection.groupBy({
        // ISSUE-006: preferenceGroupId rides the SAME query (guidebook §3b
        // "ride the include") so the dashboard can resolve a group's config by
        // its stable ID instead of its label. A RENAMED group leaves historical
        // rows carrying the OLD label snapshot, which no longer matches the
        // live config — the section then lost its multi-pick/quantity flags and
        // rendered the single-pick chip. Finer grouping only; merged below.
        by: ['groupLabelSnapshot', 'optionLabelSnapshot', 'preferenceGroupId'],
        where: {
          record: { mealId, organizationId, attendanceDate, status: 'present' },
        },
        _sum: { quantity: true },
        // Live-Test-11 ISSUE-016: pick-row counts ride the same query so the
        // Kitchen Summary can validate HEADCOUNT (who picked) separately from
        // the quantity totals it serves ("Ruti ×3" = 1 member, 3 plates).
        _count: { _all: true },
      }),
      // Live-Test-11 ISSUE-004: DISTINCT-RESPONDENT counts per group label.
      // A multi-pick member creates one selection ROW per option, so the
      // pick-row count above overcounts headcount ("4 of 3" false mismatch).
      // Grouping by (groupLabel, recordId) collapses each member to one row
      // per group — the Kitchen Summary validates THIS against Present
      // headcount (1 member = 1, regardless of picks or quantities).
      this.prisma.attendancePreferenceSelection.groupBy({
        by: ['groupLabelSnapshot', 'attendanceRecordId'],
        where: {
          record: { mealId, organizationId, attendanceDate, status: 'present' },
        },
        _count: { _all: true },
      }),
    ]);

    const statusCounts = { present: 0, absent: 0, skipped: 0 };
    for (const row of statusGroups) {
      const s = row.status as string;
      if (s === 'present') statusCounts.present = row._count.status;
      else if (s === 'absent') statusCounts.absent = row._count.status;
      else if (s === 'skipped') statusCounts.skipped = row._count.status;
    }

    // ISSUE-002: NULL → system None, and both None spellings collapse onto one
    // key so the hidden tally is never split in two. Accumulated (not
    // assigned) because several raw values can normalize to the same bucket.
    const preferenceBreakdown: Record<string, number> = {};
    for (const row of prefGroups) {
      // Guarded above: when preferences are inactive the query already
      // excluded NULLs, so normalize only ever sees real values here.
      const key = normalizePreferenceKey(row.preference);
      preferenceBreakdown[key] =
        (preferenceBreakdown[key] ?? 0) + ((row._count as any)?._all ?? 0);
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

    // Nested { groupLabel: { optionLabel: totalQuantity } } — empty for groups
    // that only use the legacy flat preference (additive, never breaks old UI).
    const preferenceGroupBreakdown: Record<string, Record<string, number>> = {};
    // ISSUE-016 (additive): { groupLabel: pickRowCount } — how many member
    // picks the group received, independent of quantities. The Kitchen
    // Summary validates THIS against headcount while serving qty totals.
    const preferenceGroupPickCounts: Record<string, number> = {};
    // ISSUE-006: label → group id, so a renamed group still resolves its config.
    const preferenceGroupIdByLabel: Record<string, string> = {};
    for (const row of selectionGroups) {
      const qty = row._sum.quantity ?? 0;
      if (qty <= 0) continue;
      const groupLabel = row.groupLabelSnapshot;
      preferenceGroupBreakdown[groupLabel] ??= {};
      preferenceGroupBreakdown[groupLabel][row.optionLabelSnapshot] =
        (preferenceGroupBreakdown[groupLabel][row.optionLabelSnapshot] ?? 0) + qty;
      preferenceGroupPickCounts[groupLabel] =
        (preferenceGroupPickCounts[groupLabel] ?? 0) +
        ((row as any)._count?._all ?? 0);
      const gid = (row as any).preferenceGroupId;
      if (gid) preferenceGroupIdByLabel[groupLabel] ??= gid;
    }

    // ISSUE-004: one row per (groupLabel, record) — count = distinct members
    // who answered that preference group (multi-pick / quantity independent).
    const preferenceGroupRespondentCounts: Record<string, number> = {};
    for (const row of respondentGroups as any[]) {
      const groupLabel = row.groupLabelSnapshot as string;
      preferenceGroupRespondentCounts[groupLabel] =
        (preferenceGroupRespondentCounts[groupLabel] ?? 0) + 1;
    }

    return {
      presentCount: statusCounts.present,
      absentCount: statusCounts.absent,
      skippedCount: statusCounts.skipped,
      snapshotPrice,
      preferenceBreakdown,
      preferenceGroupBreakdown,
      preferenceGroupPickCounts,
      preferenceGroupRespondentCounts,
      preferenceGroupIdByLabel,
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
      // Live-Test-11 ISSUE-003 (additive): avatar for billing member rows.
      avatarUrl: string | null;
      // Live-Test-15: membership status, so the caller can distinguish WHO
      // seeds the bill (active) from WHO merely needs a name resolved
      // (blocked/removed members with history earlier in the period).
      status: string;
    }>;
    records: Array<{
      userId: string;
      mealId: string;
      mealName: string;
      slotKey: string;
      status: string;
      price: number | null;
      // Live-Test-11 ISSUE-017: Bill-Absent policy snapshot (absent rows).
      billAbsent: boolean | null;
      markedAt: Date | null;
      attendanceDate: Date;
    }>;
  }> {
    const [members, records] = await Promise.all([
      this.prisma.groupMember.findMany({
        // Live-Test-15: widened from `status:'active'` so a member BLOCKED or
        // REMOVED mid-period still resolves to a REAL NAME on the bill their
        // past attendance already earned (they used to render as a raw cuid
        // with null email/phone/avatar).
        //
        // PERF: this rides the query that ALREADY runs — ZERO extra round
        // trips. It does NOT change WHO is billed: the caller still seeds the
        // member list from the ACTIVE subset only, so a blocked/removed member
        // with no activity in the period stays absent from the bill.
        // 'pending' stays excluded — a join request can never have attendance.
        where: { groupId, status: { not: 'pending' } },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              role: true,
              email: true,
              phone: true,
              avatarUrl: true,
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
          // ISSUE-017: per-record Bill-Absent snapshot rides the same query.
          billAbsent: true,
          markedAt: true,
          attendanceDate: true,
          meal: { select: { name: true, displayName: true, slotKey: true } },
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
        avatarUrl: (m.user as any)?.avatarUrl ?? null,
        status: m.status as string,
      })),
      records: records.map((r) => ({
        userId: r.userId,
        mealId: r.mealId,
        mealName: r.meal?.displayName ?? r.meal?.name ?? '—',
        slotKey: (r.meal as any)?.slotKey ?? 'general',
        status: r.status as string,
        price: r.price ?? null,
        billAbsent: (r as any).billAbsent ?? null,
        markedAt: r.markedAt ?? null,
        attendanceDate: r.attendanceDate,
      })),
    };
  }
}
