import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  MealScheduleEntity,
  ScheduleEntryEntity,
} from '../entities/meal-schedule.entity';

/**
 * SchedulesRepository — all DB queries for MealSchedule and ScheduleEntry models.
 *
 * Governance rules:
 * - organizationId in every query (multi-tenant isolation).
 * - Entries always included via relation join — never separate query.
 * - Meal relation included for slotKey derivation (contract requirement).
 * - Publishing is idempotent — repeated publish calls are safe.
 * - Clone creates new draft schedule copying entries to new dates.
 */
@Injectable()
export class SchedulesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Select clauses ────────────────────────────────────────────────────────

  private get entryInclude() {
    return {
      include: {
        meal: {
          select: {
            slotKey: true,
            name: true,
            displayName: true,
            order: true,
            menuItems: true,
            imageUrl: true,
          },
        },
      },
    };
  }

  // ── Entity builders ───────────────────────────────────────────────────────

  private buildEntryEntity(raw: any): ScheduleEntryEntity {
    return new ScheduleEntryEntity({
      id: raw.id,
      scheduleId: raw.scheduleId,
      mealId: raw.mealId,
      dayOfWeek: raw.dayOfWeek,
      date: raw.date,
      openTime: raw.openTime ?? null,
      closeTime: raw.closeTime ?? null,
      preferencesEnabled: raw.preferencesEnabled ?? null,
      enabledPreferences: raw.enabledPreferences ?? [],
      menuItems: raw.menuItems ?? [],
      mealName: raw.mealName ?? null,
      notes: raw.notes ?? null,
      meal: raw.meal
        ? {
            slotKey: raw.meal.slotKey,
            name: raw.meal.name,
            displayName: raw.meal.displayName ?? null,
            order: raw.meal.order ?? 0,
            menuItems: raw.meal.menuItems ?? [],
            imageUrl: raw.meal.imageUrl ?? null,
          }
        : undefined,
    });
  }

  private buildScheduleEntity(raw: any): MealScheduleEntity {
    const entries = (raw.entries ?? []).map((e: any) => this.buildEntryEntity(e));
    return new MealScheduleEntity({
      id: raw.id,
      organizationId: raw.organizationId,
      groupId: raw.groupId,
      weekStart: raw.weekStart,
      isPublished: raw.isPublished,
      publishedAt: raw.publishedAt ?? null,
      entries,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async findById(id: string, organizationId: string): Promise<MealScheduleEntity | null> {
    const schedule = await this.prisma.mealSchedule.findFirst({
      where: { id, organizationId },
      include: {
        entries: {
          ...this.entryInclude,
          orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
        },
      },
    });
    return schedule ? this.buildScheduleEntity(schedule) : null;
  }

  async findByGroup(
    groupId: string,
    organizationId: string,
    opts: { page: number; limit: number; publishedOnly?: boolean },
  ): Promise<{ data: MealScheduleEntity[]; total: number; page: number; limit: number }> {
    const where = {
      groupId,
      organizationId,
      ...(opts.publishedOnly ? { isPublished: true } : {}),
    };
    const skip = (opts.page - 1) * opts.limit;
    const [schedules, total] = await Promise.all([
      this.prisma.mealSchedule.findMany({
        where,
        skip,
        take: opts.limit,
        orderBy: { weekStart: 'desc' },
        include: {
          entries: {
            ...this.entryInclude,
            orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
          },
        },
      }),
      this.prisma.mealSchedule.count({ where }),
    ]);
    return { data: schedules.map((s) => this.buildScheduleEntity(s)), total, page: opts.page, limit: opts.limit };
  }

  async findPublishedForWeek(groupId: string, organizationId: string, weekStart: Date): Promise<MealScheduleEntity | null> {
    const schedule = await this.prisma.mealSchedule.findFirst({
      where: { groupId, organizationId, weekStart, isPublished: true },
      include: {
        entries: {
          ...this.entryInclude,
          orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
        },
      },
    });
    return schedule ? this.buildScheduleEntity(schedule) : null;
  }

  /**
   * Additive overlay for GET /meals/today (Weekly / Day-Wise Meal Mode).
   * Returns per-meal overrides for TODAY (org timezone) sourced from the
   * group's published schedule. Empty map = no active schedule for today,
   * so the caller falls back to master meals (no behavioural change).
   */
  async findTodayOverlay(
    groupId: string,
    organizationId: string,
  ): Promise<
    Map<
      string,
      {
        openTime: string | null;
        closeTime: string | null;
        mealName: string | null;
        preferencesEnabled: boolean | null;
        enabledPreferences: string[];
        menuItems: string[];
      }
    >
  > {
    const overlay = new Map<
      string,
      {
        openTime: string | null;
        closeTime: string | null;
        mealName: string | null;
        preferencesEnabled: boolean | null;
        enabledPreferences: string[];
        menuItems: string[];
      }
    >();

    // Resolve org timezone (same source the attendance engine uses).
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const tz = org?.timezone ?? 'Asia/Kolkata';

    // Today's calendar date in org tz -> UTC midnight + dayOfWeek (0=Mon..6=Sun).
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [yy, mm, dd] = todayStr.split('-').map(Number);
    const todayUtc = new Date(Date.UTC(yy, mm - 1, dd));
    const dow = (todayUtc.getUTCDay() + 6) % 7;
    const weekStart = new Date(todayUtc.getTime() - dow * 86400000);

    // 1) Exact published week (true date-based / Day-Wise).
    const weekSchedule = await this.findPublishedForWeek(
      groupId,
      organizationId,
      weekStart,
    );
    let entries = weekSchedule
      ? weekSchedule.entries.filter(
          (e) => e.date.getTime() === todayUtc.getTime(),
        )
      : [];

    // 2) Fallback: most recent published schedule matched by weekday (recurring).
    if (entries.length === 0) {
      const recent = await this.findByGroup(groupId, organizationId, {
        page: 1,
        limit: 1,
        publishedOnly: true,
      });
      const latest = recent.data[0];
      if (latest) {
        entries = latest.entries.filter((e) => e.dayOfWeek === dow);
      }
    }

    for (const e of entries) {
      overlay.set(e.mealId, {
        openTime: e.openTime ?? null,
        closeTime: e.closeTime ?? null,
        mealName: e.mealName ?? null,
        preferencesEnabled: e.preferencesEnabled ?? null,
        enabledPreferences: e.enabledPreferences ?? [],
        menuItems: e.menuItems ?? [],
      });
    }
    return overlay;
  }

  async create(data: {
    organizationId: string;
    groupId: string;
    weekStart: Date;
    entries?: Array<{
      mealId: string;
      dayOfWeek: number;
      date: Date;
      mealName?: string | null;
      notes?: string | null;
      openTime?: string | null;
      closeTime?: string | null;
      preferencesEnabled?: boolean | null;
      enabledPreferences?: string[] | null;
      menuItems?: string[] | null;
    }>;
  }): Promise<MealScheduleEntity> {
    const schedule = await this.prisma.mealSchedule.create({
      data: {
        organizationId: data.organizationId,
        groupId: data.groupId,
        weekStart: data.weekStart,
        isPublished: false,
        entries: data.entries?.length
          ? {
              create: data.entries.map((e) => ({
                mealId: e.mealId,
                dayOfWeek: e.dayOfWeek,
                date: e.date,
                mealName: e.mealName ?? null,
                notes: e.notes ?? null,
                openTime: e.openTime ?? null,
                closeTime: e.closeTime ?? null,
                preferencesEnabled: e.preferencesEnabled ?? null,
                enabledPreferences: e.enabledPreferences ?? [],
                menuItems: e.menuItems ?? [],
              })),
            }
          : undefined,
      },
      include: {
        entries: {
          ...this.entryInclude,
          orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
        },
      },
    });
    return this.buildScheduleEntity(schedule);
  }

  async update(
    id: string,
    organizationId: string,
    data: {
      weekStart?: Date;
      entries?: Array<{
        id?: string;
        mealId: string;
        dayOfWeek: number;
        date: Date;
        mealName?: string | null;
        notes?: string | null;
        openTime?: string | null;
        closeTime?: string | null;
        preferencesEnabled?: boolean | null;
        enabledPreferences?: string[] | null;
      menuItems?: string[] | null;
      }>;
      replaceEntries?: boolean;
    },
  ): Promise<MealScheduleEntity> {
    await this.prisma.$transaction(async (tx) => {
      const scheduleUpdate: any = {};
      if (data.weekStart !== undefined) scheduleUpdate.weekStart = data.weekStart;

      if (Object.keys(scheduleUpdate).length > 0) {
        const result = await tx.mealSchedule.updateMany({
          where: { id, organizationId },
          data: scheduleUpdate,
        });
        if (result.count === 0) throw new NotFoundException('Schedule not found');
      }

      if (data.entries !== undefined) {
        if (data.replaceEntries) {
          await tx.scheduleEntry.deleteMany({ where: { scheduleId: id } });
          if (data.entries.length > 0) {
            await tx.scheduleEntry.createMany({
              data: data.entries.map((e) => ({
                scheduleId: id,
                mealId: e.mealId,
                dayOfWeek: e.dayOfWeek,
                date: e.date,
                mealName: e.mealName ?? null,
                notes: e.notes ?? null,
                openTime: e.openTime ?? null,
                closeTime: e.closeTime ?? null,
                preferencesEnabled: e.preferencesEnabled ?? null,
                enabledPreferences: e.enabledPreferences ?? [],
                menuItems: e.menuItems ?? [],
              })),
            });
          }
        } else {
          for (const entry of data.entries) {
            if (entry.id) {
              await tx.scheduleEntry.updateMany({
                where: { id: entry.id, scheduleId: id },
                data: {
                  mealId: entry.mealId,
                  dayOfWeek: entry.dayOfWeek,
                  date: entry.date,
                  mealName: entry.mealName ?? null,
                  notes: entry.notes ?? null,
                  openTime: entry.openTime ?? null,
                  closeTime: entry.closeTime ?? null,
                  preferencesEnabled: entry.preferencesEnabled ?? null,
                  enabledPreferences: entry.enabledPreferences ?? [],
                  menuItems: entry.menuItems ?? [],
                },
              });
            } else {
              await tx.scheduleEntry.create({
                data: {
                  scheduleId: id,
                  mealId: entry.mealId,
                  dayOfWeek: entry.dayOfWeek,
                  date: entry.date,
                  mealName: entry.mealName ?? null,
                  notes: entry.notes ?? null,
                  openTime: entry.openTime ?? null,
                  closeTime: entry.closeTime ?? null,
                  preferencesEnabled: entry.preferencesEnabled ?? null,
                  enabledPreferences: entry.enabledPreferences ?? [],
                  menuItems: entry.menuItems ?? [],
                },
              });
            }
          }
        }
      }
    });
    return this.findById(id, organizationId) as Promise<MealScheduleEntity>;
  }

  async publish(id: string, organizationId: string): Promise<MealScheduleEntity> {
    const result = await this.prisma.mealSchedule.updateMany({
      where: { id, organizationId },
      data: { isPublished: true, publishedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Schedule not found');
    return this.findById(id, organizationId) as Promise<MealScheduleEntity>;
  }

  // Issue 2: revert a published schedule back to draft (inverse of publish).
  // Additive — mirrors publish(); idempotent and org-isolated.
  async revert(id: string, organizationId: string): Promise<MealScheduleEntity> {
    const result = await this.prisma.mealSchedule.updateMany({
      where: { id, organizationId },
      data: { isPublished: false, publishedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Schedule not found');
    return this.findById(id, organizationId) as Promise<MealScheduleEntity>;
  }

  async clone(sourceId: string, organizationId: string, targetWeekStart: Date): Promise<MealScheduleEntity> {
    const source = await this.findById(sourceId, organizationId);
    if (!source) throw new NotFoundException('Source schedule not found');

    const offsetMs = targetWeekStart.getTime() - source.weekStart.getTime();

    return this.prisma.$transaction(async (tx) => {
      const newSchedule = await tx.mealSchedule.create({
        data: {
          organizationId,
          groupId: source.groupId,
          weekStart: targetWeekStart,
          isPublished: false,
          entries: source.entries.length
            ? {
                create: source.entries.map((e) => ({
                  mealId: e.mealId,
                  dayOfWeek: e.dayOfWeek,
                  date: new Date(e.date.getTime() + offsetMs),
                  mealName: e.mealName ?? null,
                  notes: e.notes ?? null,
                  openTime: e.openTime ?? null,
                  closeTime: e.closeTime ?? null,
                  preferencesEnabled: e.preferencesEnabled ?? null,
                  enabledPreferences: e.enabledPreferences ?? [],
                  menuItems: e.menuItems ?? [],
                })),
              }
            : undefined,
        },
        include: {
          entries: {
            ...this.entryInclude,
            orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
          },
        },
      });
      return this.buildScheduleEntity(newSchedule);
    });
  }
}
