import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** Prisma include used everywhere a group travels with its options. */
const WITH_OPTIONS = {
  options: { orderBy: [{ order: 'asc' as const }, { createdAt: 'asc' as const }] },
};

export type PreferenceGroupWithOptions = NonNullable<
  Awaited<ReturnType<PreferenceGroupsRepository['findById']>>
>;

/**
 * Module 36 (FR-PG-*) data access. Every query is organizationId-scoped
 * (FR-PG-073). Deletes are soft (isActive=false) so historical selection
 * snapshots stay meaningful (FR-PG-072).
 */
@Injectable()
export class PreferenceGroupsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Groups ─────────────────────────────────────────────────────────────────

  findById(id: string, organizationId: string) {
    return this.prisma.preferenceGroup.findFirst({
      where: { id, organizationId },
      include: WITH_OPTIONS,
    });
  }

  /** Templates usable by a group: group-scoped + org-level (groupId null). */
  listTemplates(organizationId: string, groupId: string) {
    return this.prisma.preferenceGroup.findMany({
      where: {
        organizationId,
        isActive: true,
        OR: [{ groupId }, { groupId: null }],
      },
      include: WITH_OPTIONS,
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  createGroup(data: {
    organizationId: string;
    groupId: string | null;
    scope: string;
    label: string;
    description?: string | null;
    order?: number;
    selectionType?: string;
    minSelect?: number;
    maxSelect?: number;
    required?: boolean;
    quantityEnabled?: boolean;
    visibleWhen?: object | null;
    vegOnly?: boolean;
    options?: Array<{
      key: string;
      label: string;
      emoji?: string | null;
      color?: string | null;
      isVeg?: boolean;
      priceDelta?: number;
      minQty?: number;
      maxQty?: number;
      order?: number;
    }>;
  }) {
    const { options, visibleWhen, ...group } = data;
    return this.prisma.preferenceGroup.create({
      data: {
        ...group,
        visibleWhen: visibleWhen ?? undefined,
        ...(options?.length
          ? { options: { create: options.map((o, i) => ({ order: o.order ?? i, ...o })) } }
          : {}),
      },
      include: WITH_OPTIONS,
    });
  }

  updateGroup(
    id: string,
    organizationId: string,
    data: Partial<{
      label: string;
      description: string | null;
      order: number;
      selectionType: string;
      minSelect: number;
      maxSelect: number;
      required: boolean;
      quantityEnabled: boolean;
      visibleWhen: object | null;
      vegOnly: boolean;
      isActive: boolean;
    }>,
  ) {
    const { visibleWhen, ...rest } = data;
    return this.prisma.preferenceGroup.update({
      // updateMany cannot include; findFirst guarded by caller ensures tenancy.
      where: { id },
      data: {
        ...rest,
        ...(visibleWhen !== undefined
          ? { visibleWhen: visibleWhen === null ? Prisma.DbNull : visibleWhen }
          : {}),
      },
      include: WITH_OPTIONS,
    });
  }

  // ── Options ────────────────────────────────────────────────────────────────

  findOptionById(id: string) {
    return this.prisma.preferenceOption.findUnique({
      where: { id },
      include: { group: true },
    });
  }

  createOption(data: {
    preferenceGroupId: string;
    key: string;
    label: string;
    emoji?: string | null;
    color?: string | null;
    isVeg?: boolean;
    priceDelta?: number;
    minQty?: number;
    maxQty?: number;
    order?: number;
  }) {
    return this.prisma.preferenceOption.create({ data });
  }

  updateOption(
    id: string,
    data: Partial<{
      label: string;
      emoji: string | null;
      color: string | null;
      isVeg: boolean;
      priceDelta: number;
      minQty: number;
      maxQty: number;
      order: number;
      isActive: boolean;
    }>,
  ) {
    return this.prisma.preferenceOption.update({ where: { id }, data });
  }

  countActiveOptions(preferenceGroupId: string) {
    return this.prisma.preferenceOption.count({
      where: { preferenceGroupId, isActive: true },
    });
  }

  /** FR-PG-072: a key with historical selections is immutable. */
  hasHistoricalSelections(preferenceGroupId: string, optionKey?: string) {
    return this.prisma.attendancePreferenceSelection
      .findFirst({
        where: { preferenceGroupId, ...(optionKey ? { optionKey } : {}) },
        select: { id: true },
      })
      .then((row) => row !== null);
  }

  // ── Meal bindings ──────────────────────────────────────────────────────────

  listBindingsForMeal(mealId: string) {
    return this.prisma.mealPreferenceGroup.findMany({
      where: { mealId },
      include: { preferenceGroup: { include: WITH_OPTIONS } },
      orderBy: { order: 'asc' },
    });
  }

  /** Batch load for /meals/today embedding — one query, no N+1 (FR-PG-090). */
  listBindingsForMeals(mealIds: string[]) {
    if (mealIds.length === 0) return Promise.resolve([]);
    return this.prisma.mealPreferenceGroup.findMany({
      where: { mealId: { in: mealIds } },
      include: { preferenceGroup: { include: WITH_OPTIONS } },
      orderBy: { order: 'asc' },
    });
  }

  countBindingsForMeal(mealId: string) {
    return this.prisma.mealPreferenceGroup.count({ where: { mealId } });
  }

  bindToMeal(data: {
    mealId: string;
    preferenceGroupId: string;
    order?: number;
    requiredOverride?: boolean | null;
    minSelectOverride?: number | null;
    maxSelectOverride?: number | null;
  }) {
    return this.prisma.mealPreferenceGroup.upsert({
      where: {
        mealId_preferenceGroupId: {
          mealId: data.mealId,
          preferenceGroupId: data.preferenceGroupId,
        },
      },
      create: data,
      update: {
        order: data.order,
        requiredOverride: data.requiredOverride,
        minSelectOverride: data.minSelectOverride,
        maxSelectOverride: data.maxSelectOverride,
      },
      include: { preferenceGroup: { include: WITH_OPTIONS } },
    });
  }

  unbindFromMeal(mealId: string, preferenceGroupId: string) {
    return this.prisma.mealPreferenceGroup.deleteMany({
      where: { mealId, preferenceGroupId },
    });
  }

  /**
   * Live-Test-8 ISSUE-001/002: suspend (false) or restore (true) ALL of a
   * meal's group bindings in one statement. Suspended bindings stay stored —
   * the effective-view builder skips them — so a Standalone↔Groups mode
   * switch never loses the admin's configuration.
   */
  setBindingsActive(mealId: string, active: boolean) {
    return this.prisma.mealPreferenceGroup.updateMany({
      where: { mealId },
      data: { isActive: active } as any,
    });
  }

  // ── Cross-tab analytics (FR-PG-050/051) ────────────────────────────────────

  /**
   * Per-group-per-option counts + quantities for attending members on a date.
   * One groupBy query over the indexed (preferenceGroupId, optionKey) pair.
   */
  crossTab(organizationId: string, groupId: string, date: Date, mealId?: string) {
    return this.prisma.attendancePreferenceSelection.groupBy({
      by: ['preferenceGroupId', 'groupLabelSnapshot', 'optionKey', 'optionLabelSnapshot'],
      where: {
        record: {
          organizationId,
          groupId,
          attendanceDate: date,
          status: 'present',
          ...(mealId ? { mealId } : {}),
        },
      },
      _count: { _all: true },
      _sum: { quantity: true },
    });
  }
}
