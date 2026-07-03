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
    },
  ): Promise<{ data: MealEntity[]; total: number; page: number; limit: number }> {
    const where = {
      groupId,
      organizationId, // CRITICAL: tenant isolation
      ...(opts.includeDisabled ? {} : { isActive: true }),
      ...(opts.slotKey ? { slotKey: opts.slotKey } : {}),
    };
    const skip = (opts.page - 1) * opts.limit;

    const [meals, total] = await Promise.all([
      this.prisma.meal.findMany({
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
      }),
      this.prisma.meal.count({ where }),
    ]);

    return {
      data: meals.map((m) => this.buildEntity(m)),
      total,
      page: opts.page,
      limit: opts.limit,
    };
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
      where: { id, organizationId, isActive: true },
      data: { isActive: false },
    });

    if (result.count === 0) {
      throw new NotFoundException('Meal not found or already archived');
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
