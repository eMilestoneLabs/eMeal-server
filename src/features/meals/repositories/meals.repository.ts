import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MealEntity } from '../entities/meal.entity';

/**
 * MealsRepository — all DB queries for the Meal model.
 *
 * Governance rules:
 * - Every query MUST include organizationId in WHERE (multi-tenant isolation).
 * - organizationId always comes from JWT — never from client payload.
 * - Soft-delete: isActive=false. Hard delete never used.
 * - slotKey is always free-form string — NEVER validated as enum here.
 * - Results ordered chronologically by attendance-window open time (FR-MEAL-007,
 *   ISSUE-18): "HH:mm" ASC with windowless meals last, then `order ASC,
 *   createdAt ASC` as stable tie-breakers — Morning Tea 06:30 → Breakfast 08:00
 *   → Lunch 12:00 regardless of creation order.
 */
@Injectable()
export class MealsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Entity builder ────────────────────────────────────────────────────────

  private buildEntity(raw: any): MealEntity {
    return new MealEntity({
      id: raw.id,
      organizationId: raw.organizationId,
      groupId: raw.groupId,
      slotKey: raw.slotKey,
      name: raw.name,
      displayName: raw.displayName ?? null,
      order: raw.order ?? 0,
      isActive: raw.isActive,
      deletedAt: raw.deletedAt ?? null,
      attendanceEnabled: raw.attendanceEnabled,
      description: raw.description ?? null,
      menuItems: raw.menuItems ?? [],
      imageUrl: raw.imageUrl ?? null,
      preferencesEnabled: raw.preferencesEnabled,
      enabledPreferences: raw.enabledPreferences ?? [],
      attendanceWindowOpen: raw.attendanceWindowOpen ?? null,
      attendanceWindowClose: raw.attendanceWindowClose ?? null,
      price: raw.price ?? null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async findById(
    id: string,
    organizationId: string,
    includeDisabled = false,
  ): Promise<MealEntity | null> {
    const meal = await this.prisma.meal.findFirst({
      where: {
        id,
        organizationId, // CRITICAL: tenant isolation
        ...(includeDisabled ? {} : { isActive: true }),
      },
    });
    return meal ? this.buildEntity(meal) : null;
  }

  /**
   * List meals for a group — chronological by attendance-window open time
   * (FR-MEAL-007), windowless meals last, `order ASC, createdAt ASC` tie-break.
   * Admin can see disabled meals; students see only isActive=true.
   */
  async findByGroup(
    groupId: string,
    organizationId: string,
    opts: {
      page: number;
      limit: number;
      slotKey?: string;
      includeDisabled?: boolean;
      // command_6 ultra pass: preference-group bindings (with their groups +
      // options) ride the SAME query, so list callers skip the second wave.
      withPreferenceBindings?: boolean;
    },
  ): Promise<{
    data: MealEntity[];
    total: number;
    page: number;
    limit: number;
    bindings?: any[];
  }> {
    const where = {
      groupId,
      organizationId, // CRITICAL: tenant isolation
      // ISSUE-001: DELETED meals leave the Master Meal Template PERMANENTLY —
      // unconditionally, even for includeDisabled (which exists so the admin
      // can re-enable a temporarily DISABLED meal, never to resurrect a
      // deleted one). History paths never come through here: they read
      // attendance/billing rows or the published snapshot, and
      // findByIdsAnyState still resolves deleted meals by id for those.
      deletedAt: null,
      ...(opts.includeDisabled ? {} : { isActive: true }),
      ...(opts.slotKey ? { slotKey: opts.slotKey } : {}),
    };
    const skip = (opts.page - 1) * opts.limit;

    const meals = await this.prisma.meal.findMany({
      where,
      skip,
      take: opts.limit,
      orderBy: [
        // FR-MEAL-007 (ISSUE-18): zero-padded "HH:mm" strings sort correctly
        // as text; meals with no window go last.
        { attendanceWindowOpen: { sort: 'asc', nulls: 'last' } },
        { order: 'asc' },
        { createdAt: 'asc' },
      ],
      ...(opts.withPreferenceBindings
        ? {
            include: {
              preferenceGroupBindings: {
                include: {
                  preferenceGroup: {
                    include: {
                      options: {
                        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
                      },
                    },
                  },
                },
                orderBy: { order: 'asc' },
              },
            },
          }
        : {}),
    });
    // Perf (2026-07-19): an under-filled page pins the exact total without a
    // COUNT round trip — with the MMT cap (10 meals/group) vs the today
    // path's limit of 50, the separate COUNT never fires in practice. A full
    // page (only possible for exotic limits) still pays the exact COUNT, so
    // the pagination contract's `total` stays precise in every case.
    const underfilled =
      meals.length < opts.limit && (skip === 0 || meals.length > 0);
    const total = underfilled
      ? skip + meals.length
      : await this.prisma.meal.count({ where });

    // Bindings are stripped from the rows before entity build so the entity /
    // serializer payload stays byte-identical to the legacy shape.
    const bindings = opts.withPreferenceBindings
      ? (meals as any[]).flatMap((m) => m.preferenceGroupBindings ?? [])
      : undefined;
    return {
      data: (meals as any[]).map((m) => {
        const { preferenceGroupBindings: _b, ...rest } = m;
        return this.buildEntity(rest);
      }),
      total,
      page: opts.page,
      limit: opts.limit,
      ...(bindings ? { bindings } : {}),
    };
  }

  /**
   * Live-Test-9 ISSUE-002: batch lookup that INCLUDES archived meals.
   * Used by GET /meals/today to keep rendering meals that were soft-deleted
   * AFTER the current schedule was published — the frozen snapshot still
   * carries them, and members keep the last published week fully operational
   * until the admin republishes. Group + org scoped (tenant isolation).
   */
  async findByIdsAnyState(
    ids: string[],
    groupId: string,
    organizationId: string,
  ): Promise<MealEntity[]> {
    if (ids.length === 0) return [];
    const meals = await this.prisma.meal.findMany({
      where: {
        id: { in: ids },
        groupId,
        organizationId, // CRITICAL: tenant isolation
      },
      orderBy: [
        { attendanceWindowOpen: { sort: 'asc', nulls: 'last' } },
        { order: 'asc' },
        { createdAt: 'asc' },
      ],
    });
    return meals.map((m) => this.buildEntity(m));
  }

  /**
   * SRS Module 03 MMT-001/MMT-014: active meals currently in the group,
   * excluding the implicit general-attendance slot — the cap governs the
   * admin-visible Master Meal Template, not the hidden AO-mode slot.
   */
  async countActiveInGroup(
    groupId: string,
    organizationId: string,
    excludeSlotKey?: string,
  ): Promise<number> {
    return this.prisma.meal.count({
      where: {
        groupId,
        organizationId, // CRITICAL: tenant isolation
        isActive: true,
        ...(excludeSlotKey ? { slotKey: { not: excludeSlotKey } } : {}),
      },
    });
  }

  /**
   * Live-Test-16 ISSUE-2: the group's ACTIVE meal windows, narrow-selected for
   * the attendance-window invariant (no overlap, minimum gap).
   *
   * Deliberately SEPARATE from `countActiveInGroup` rather than replacing it:
   * that count is the shipped MMT-001/014 cap guard, so it is left byte-for-
   * byte alone and `createMeal` runs the two together in one `Promise.all`
   * (one extra narrow read of at most `cap` rows, no additional latency wave).
   *
   * Bounded by the meal cap, so the un-indexed `orderBy` sorts a handful of
   * rows already filtered by the indexed groupId + organizationId.
   */
  async findActiveWindowsInGroup(
    groupId: string,
    organizationId: string,
    opts: { excludeSlotKey?: string; excludeMealId?: string } = {},
  ): Promise<
    Array<{
      id: string;
      name: string;
      displayName: string | null;
      slotKey: string;
      attendanceWindowOpen: string | null;
      attendanceWindowClose: string | null;
    }>
  > {
    return this.prisma.meal.findMany({
      where: {
        groupId,
        organizationId, // CRITICAL: tenant isolation
        isActive: true,
        ...(opts.excludeSlotKey ? { slotKey: { not: opts.excludeSlotKey } } : {}),
        ...(opts.excludeMealId ? { id: { not: opts.excludeMealId } } : {}),
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        slotKey: true,
        attendanceWindowOpen: true,
        attendanceWindowClose: true,
      },
      orderBy: { attendanceWindowOpen: 'asc' },
    });
  }

  /**
   * SRS Module 03 MMT-003: meal Name is unique per group (case-insensitive,
   * active meals only — an archived meal's name is reusable).
   */
  async existsByNameInGroup(
    groupId: string,
    organizationId: string,
    name: string,
    excludeId?: string,
  ): Promise<boolean> {
    const hit = await this.prisma.meal.findFirst({
      where: {
        groupId,
        organizationId, // CRITICAL: tenant isolation
        isActive: true,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    return !!hit;
  }

  async create(data: {
    organizationId: string;
    groupId: string;
    slotKey: string;
    name: string;
    displayName?: string | null;
    order?: number;
    attendanceEnabled?: boolean;
    description?: string | null;
    menuItems?: string[];
    imageUrl?: string | null;
    preferencesEnabled?: boolean;
    enabledPreferences?: string[];
    attendanceWindowOpen?: string | null;
    attendanceWindowClose?: string | null;
    price?: number | null;
  }): Promise<MealEntity> {
    const meal = await this.prisma.meal.create({
      data: {
        organizationId: data.organizationId,
        groupId: data.groupId,
        slotKey: data.slotKey,
        name: data.name,
        displayName: data.displayName ?? null,
        order: data.order ?? 0,
        attendanceEnabled: data.attendanceEnabled ?? true,
        description: data.description ?? null,
        menuItems: data.menuItems ?? [],
        imageUrl: data.imageUrl ?? null,
        preferencesEnabled: data.preferencesEnabled ?? false,
        enabledPreferences: data.enabledPreferences ?? [],
        attendanceWindowOpen: data.attendanceWindowOpen ?? null,
        attendanceWindowClose: data.attendanceWindowClose ?? null,
        price: data.price ?? null,
      },
    });
    return this.buildEntity(meal);
  }

  /**
   * Update a meal — uses updateMany to enforce org isolation atomically.
   * If count=0, the meal doesn't exist in this org → NotFoundException.
   */
  async update(
    id: string,
    organizationId: string,
    data: Partial<{
      slotKey: string;
      name: string;
      displayName: string | null;
      order: number;
      isActive: boolean;
      attendanceEnabled: boolean;
      description: string | null;
      menuItems: string[];
      imageUrl: string | null;
      preferencesEnabled: boolean;
      enabledPreferences: string[];
      attendanceWindowOpen: string | null;
      attendanceWindowClose: string | null;
      price: number | null;
    }>,
  ): Promise<MealEntity> {
    const result = await this.prisma.meal.updateMany({
      where: { id, organizationId },
      data,
    });

    if (result.count === 0) {
      throw new NotFoundException('Meal not found');
    }

    return this.findById(id, organizationId, true) as Promise<MealEntity>;
  }

  /**
   * Soft delete — sets isActive=false.
   * Schedule entries, attendance records preserved (audit trail intact).
   */
  async softDelete(id: string, organizationId: string): Promise<void> {
    const result = await this.prisma.meal.updateMany({
      // ISSUE-001: gated on deletedAt (NOT isActive) — a DISABLED meal is now
      // listed in the Master Meal Template (so it can be re-enabled), which
      // means its Delete action is reachable too. The old `isActive: true`
      // guard matched zero rows for a disabled meal and failed with
      // "already archived", making disabled meals impossible to delete.
      // Deleting an already-DELETED meal still correctly 404s.
      where: { id, organizationId, deletedAt: null },
      // Stamping deletedAt is what makes DELETE permanent and distinguishable
      // from DISABLE (which only clears isActive). The row itself survives so
      // attendance, billing, reports and published snapshots keep resolving
      // the meal's name and price.
      data: { isActive: false, deletedAt: new Date() },
    });

    if (result.count === 0) {
      throw new NotFoundException('Meal not found or already deleted');
    }
  }

  /**
   * Reorder meals — bulk update order field.
   * Accepts ordered array of meal IDs → sets order = array index.
   * All updates executed in a transaction for consistency.
   */
  async reorder(
    mealIds: string[],
    organizationId: string,
  ): Promise<void> {
    const updates = mealIds.map((id, index) =>
      this.prisma.meal.updateMany({
        where: { id, organizationId },
        data: { order: index },
      }),
    );
    await this.prisma.$transaction(updates);
  }

  /**
   * Verify a meal belongs to a given group AND organization.
   * Used by SchedulesService before creating entries.
   */
  async verifyGroupOwnership(
    mealId: string,
    groupId: string,
    organizationId: string,
  ): Promise<boolean> {
    const count = await this.prisma.meal.count({
      where: { id: mealId, groupId, organizationId, isActive: true },
    });
    return count > 0;
  }

  /**
   * Resolve an organization's IANA timezone (defaults to Asia/Kolkata).
   * Used by the price-lock guard to compute "now" in the org's local time.
   */
  async getOrganizationTimezone(organizationId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }
}
