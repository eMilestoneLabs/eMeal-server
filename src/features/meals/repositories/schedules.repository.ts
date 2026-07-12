import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  MealScheduleEntity,
  ScheduleEntryEntity,
} from '../entities/meal-schedule.entity';
import { compareEntriesChronologically } from '../utils/entry-chrono.util';

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
            description: true,
            price: true,
            // FR-MEAL-007: template window for chronological ordering
            attendanceWindowOpen: true,
            attendanceWindowClose: true,
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
      enabledPreferenceGroupIds: raw.enabledPreferenceGroupIds ?? [],
      menuItems: raw.menuItems ?? [],
      price: raw.price ?? null,
      mealName: raw.mealName ?? null,
      notes: raw.notes ?? null,
      description: raw.description ?? null,
      imageUrl: raw.imageUrl ?? null,
      meal: raw.meal
        ? {
            slotKey: raw.meal.slotKey,
            name: raw.meal.name,
            displayName: raw.meal.displayName ?? null,
            order: raw.meal.order ?? 0,
            menuItems: raw.meal.menuItems ?? [],
            imageUrl: raw.meal.imageUrl ?? null,
            description: raw.meal.description ?? null,
            price: raw.meal.price ?? null,
            attendanceWindowOpen: raw.meal.attendanceWindowOpen ?? null,
            attendanceWindowClose: raw.meal.attendanceWindowClose ?? null,
          }
        : undefined,
    });
  }

  // ── FR-MEAL-007 (ISSUE-18): chronological within-day entry ordering ────────

  /** Day ASC, then the shared chronological rule (entry-chrono.util). */
  private static sortEntriesChronologically(
    entries: ScheduleEntryEntity[],
  ): ScheduleEntryEntity[] {
    return entries.sort((a, b) => {
      if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
      return compareEntriesChronologically(a, b);
    });
  }

  private buildScheduleEntity(raw: any): MealScheduleEntity {
    const entries = SchedulesRepository.sortEntriesChronologically(
      (raw.entries ?? []).map((e: any) => this.buildEntryEntity(e)),
    );
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

  // ── Issue 1: published snapshot helpers ───────────────────────────────────

  /** Serialize live entries (with meal join) into the frozen published snapshot. */
  private snapshotFromEntries(entries: ScheduleEntryEntity[]): any[] {
    return entries.map((e) => ({
      id: e.id,
      scheduleId: e.scheduleId,
      mealId: e.mealId,
      dayOfWeek: e.dayOfWeek,
      date: e.date instanceof Date ? e.date.toISOString() : e.date,
      openTime: e.openTime ?? null,
      closeTime: e.closeTime ?? null,
      mealName: e.mealName ?? null,
      notes: e.notes ?? null,
      description: e.description ?? null,
      imageUrl: e.imageUrl ?? null,
      preferencesEnabled: e.preferencesEnabled ?? null,
      enabledPreferences: e.enabledPreferences ?? [],
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
      menuItems: e.menuItems ?? [],
      price: e.price ?? null,
      meal: e.meal
        ? {
            slotKey: e.meal.slotKey,
            name: e.meal.name,
            displayName: e.meal.displayName ?? null,
            order: e.meal.order ?? 0,
            menuItems: e.meal.menuItems ?? [],
            imageUrl: e.meal.imageUrl ?? null,
            description: e.meal.description ?? null,
            price: e.meal.price ?? null,
            attendanceWindowOpen: e.meal.attendanceWindowOpen ?? null,
            attendanceWindowClose: e.meal.attendanceWindowClose ?? null,
          }
        : undefined,
    }));
  }

  /**
   * Rebuild a schedule entity whose entries come from the published snapshot.
   * Legacy rows published before this column existed have a null snapshot — for
   * them we fall back to the live entries (safe: before this change a published
   * row could not also hold an unsynced draft, so live == published).
   */
  private scheduleFromSnapshot(raw: any): MealScheduleEntity {
    const snap = raw.publishedSnapshot;
    if (Array.isArray(snap) && snap.length > 0) {
      const entries = SchedulesRepository.sortEntriesChronologically(
        snap.map((e: any) =>
          this.buildEntryEntity({
            ...e,
            date: e.date ? new Date(e.date) : new Date(),
          }),
        ),
      );
      return new MealScheduleEntity({
        id: raw.id,
        organizationId: raw.organizationId,
        groupId: raw.groupId,
        weekStart: raw.weekStart,
        // From a student's perspective this snapshot IS the published schedule,
        // even if the admin has reverted the row to draft to edit it.
        isPublished: true,
        publishedAt: raw.publishedAt ?? null,
        entries,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      });
    }
    return this.buildScheduleEntity(raw);
  }

  /** Persist the published snapshot for a schedule from its current live entries. */
  private async captureSnapshot(id: string, organizationId: string): Promise<void> {
    const full = await this.findById(id, organizationId);
    const snapshot = full ? this.snapshotFromEntries(full.entries) : [];
    await this.prisma.mealSchedule.updateMany({
      where: { id, organizationId },
      data: { publishedSnapshot: snapshot } as any,
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
    // Students (publishedOnly) read the PUBLISHED SNAPSHOT, gated on
    // publishedAt != null so a row reverted to draft still serves its last
    // published version. Admins read the live draft entries.
    const where: any = {
      groupId,
      organizationId,
      ...(opts.publishedOnly ? { publishedAt: { not: null } } : {}),
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
    return {
      data: schedules.map((row) =>
        opts.publishedOnly
          ? this.scheduleFromSnapshot(row)
          : this.buildScheduleEntity(row),
      ),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  }

  async findPublishedForWeek(groupId: string, organizationId: string, weekStart: Date): Promise<MealScheduleEntity | null> {
    // Students read the PUBLISHED SNAPSHOT (preserved across draft edits), gated
    // on publishedAt != null ("has ever been published"). isPublished is the
    // admin-UI draft flag and is intentionally NOT used for student visibility.
    const schedule = await this.prisma.mealSchedule.findFirst({
      where: { groupId, organizationId, weekStart, publishedAt: { not: null } },
      include: {
        entries: {
          ...this.entryInclude,
          orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
        },
      },
    });
    return schedule ? this.scheduleFromSnapshot(schedule) : null;
  }

  /** Student-facing single schedule read — from the published snapshot. */
  async findPublishedById(id: string, organizationId: string): Promise<MealScheduleEntity | null> {
    const schedule = await this.prisma.mealSchedule.findFirst({
      where: { id, organizationId, publishedAt: { not: null } },
      include: {
        entries: {
          ...this.entryInclude,
          orderBy: [{ dayOfWeek: 'asc' }, { mealId: 'asc' }],
        },
      },
    });
    return schedule ? this.scheduleFromSnapshot(schedule) : null;
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
        description: string | null;
        imageUrl: string | null;
        preferencesEnabled: boolean | null;
        enabledPreferences: string[];
        enabledPreferenceGroupIds: string[];
        menuItems: string[];
        price: number | null;
      }
    >
  > {
    const overlay = new Map<
      string,
      {
        openTime: string | null;
        closeTime: string | null;
        mealName: string | null;
        description: string | null;
        imageUrl: string | null;
        preferencesEnabled: boolean | null;
        enabledPreferences: string[];
        enabledPreferenceGroupIds: string[];
        menuItems: string[];
        price: number | null;
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
        description: e.description ?? null,
        imageUrl: e.imageUrl ?? null,
        preferencesEnabled: e.preferencesEnabled ?? null,
        enabledPreferences: e.enabledPreferences ?? [],
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
        menuItems: e.menuItems ?? [],
        price: e.price ?? null,
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
      description?: string | null;
      imageUrl?: string | null;
      openTime?: string | null;
      closeTime?: string | null;
      preferencesEnabled?: boolean | null;
      enabledPreferences?: string[] | null;
      enabledPreferenceGroupIds?: string[] | null;
      menuItems?: string[] | null;
      price?: number | null;
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
                description: e.description ?? null,
                imageUrl: e.imageUrl ?? null,
                openTime: e.openTime ?? null,
                closeTime: e.closeTime ?? null,
                preferencesEnabled: e.preferencesEnabled ?? null,
                enabledPreferences: e.enabledPreferences ?? [],
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
                menuItems: e.menuItems ?? [],
                price: e.price ?? null,
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
        description?: string | null;
        imageUrl?: string | null;
        openTime?: string | null;
        closeTime?: string | null;
        preferencesEnabled?: boolean | null;
        enabledPreferences?: string[] | null;
      enabledPreferenceGroupIds?: string[] | null;
      menuItems?: string[] | null;
      price?: number | null;
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
                description: e.description ?? null,
                imageUrl: e.imageUrl ?? null,
                openTime: e.openTime ?? null,
                closeTime: e.closeTime ?? null,
                preferencesEnabled: e.preferencesEnabled ?? null,
                enabledPreferences: e.enabledPreferences ?? [],
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
                menuItems: e.menuItems ?? [],
                price: e.price ?? null,
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
                  description: entry.description ?? null,
                  imageUrl: entry.imageUrl ?? null,
                  openTime: entry.openTime ?? null,
                  closeTime: entry.closeTime ?? null,
                  preferencesEnabled: entry.preferencesEnabled ?? null,
                  enabledPreferences: entry.enabledPreferences ?? [],
      enabledPreferenceGroupIds: entry.enabledPreferenceGroupIds ?? [],
                  menuItems: entry.menuItems ?? [],
                  price: entry.price ?? null,
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
                  description: entry.description ?? null,
                  imageUrl: entry.imageUrl ?? null,
                  openTime: entry.openTime ?? null,
                  closeTime: entry.closeTime ?? null,
                  preferencesEnabled: entry.preferencesEnabled ?? null,
                  enabledPreferences: entry.enabledPreferences ?? [],
      enabledPreferenceGroupIds: entry.enabledPreferenceGroupIds ?? [],
                  menuItems: entry.menuItems ?? [],
                  price: entry.price ?? null,
                },
              });
            }
          }
        }
      }
    });
    return this.findById(id, organizationId) as Promise<MealScheduleEntity>;
  }

  /**
   * SRS Module 03 MMT-011: remove specific (stale) entries from one schedule —
   * used by the publish self-heal when a master meal was deleted/disabled
   * after the entries were drafted. Tenant-isolated via the schedule relation.
   */
  async deleteEntriesByIds(
    scheduleId: string,
    organizationId: string,
    entryIds: string[],
  ): Promise<number> {
    if (entryIds.length === 0) return 0;
    const result = await this.prisma.scheduleEntry.deleteMany({
      where: {
        id: { in: entryIds },
        scheduleId,
        schedule: { organizationId },
      },
    });
    return result.count;
  }

  /**
   * SRS Module 03 MMT-011: when a master meal is deleted it is removed from
   * all future days — purge its entries from every UNPUBLISHED (draft)
   * schedule of the org. Published schedules are left untouched so members
   * keep seeing the last published version until the admin re-publishes
   * (the publish self-heal drops the stale entries at that point).
   */
  async deleteDraftEntriesForMeal(
    mealId: string,
    organizationId: string,
  ): Promise<number> {
    const result = await this.prisma.scheduleEntry.deleteMany({
      where: {
        mealId,
        schedule: { organizationId, isPublished: false },
      },
    });
    return result.count;
  }

  async publish(id: string, organizationId: string): Promise<MealScheduleEntity> {
    // Freeze the current live entries as the published snapshot students read.
    const current = await this.findById(id, organizationId);
    const snapshot = current ? this.snapshotFromEntries(current.entries) : [];
    const result = await this.prisma.mealSchedule.updateMany({
      where: { id, organizationId },
      data: {
        isPublished: true,
        publishedAt: new Date(),
        publishedSnapshot: snapshot,
      } as any,
    });
    if (result.count === 0) throw new NotFoundException('Schedule not found');
    return this.findById(id, organizationId) as Promise<MealScheduleEntity>;
  }

  /**
   * Issue 2: atomically REPLACE a schedule's entries AND publish it in one
   * transaction. The previously published version stays live for students until
   * this commit swaps in the new entries with isPublished=true — so editing a
   * previously-published week never strands students on the master meal config.
   */
  async replaceAndPublish(
    id: string,
    organizationId: string,
    entries: Array<{
      mealId: string;
      dayOfWeek: number;
      date: Date;
      mealName?: string | null;
      notes?: string | null;
      openTime?: string | null;
      closeTime?: string | null;
      preferencesEnabled?: boolean | null;
      enabledPreferences?: string[] | null;
      enabledPreferenceGroupIds?: string[] | null;
      menuItems?: string[] | null;
      price?: number | null;
    }>,
  ): Promise<MealScheduleEntity> {
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.mealSchedule.findFirst({
        where: { id, organizationId },
        select: { id: true },
      });
      if (!owned) throw new NotFoundException('Schedule not found');

      await tx.scheduleEntry.deleteMany({ where: { scheduleId: id } });
      if (entries.length > 0) {
        await tx.scheduleEntry.createMany({
          data: entries.map((e) => ({
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
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
            menuItems: e.menuItems ?? [],
            price: e.price ?? null,
          })),
        });
      }

      // Realign weekStart to the week these entries belong to. The client always
      // (re)writes entries for the CURRENT week on publish, so without this the
      // row keeps a stale weekStart and week-scoped reads (weekly menu,
      // findPublishedForWeek) can't find the published schedule — which made
      // edits appear to "vanish" and toggles revert OFF right after publishing.
      let weekStartUpdate: Date | undefined;
      if (entries.length > 0) {
        const earliest = entries.reduce(
          (a, b) => (a.date.getTime() <= b.date.getTime() ? a : b),
        ).date;
        const dow = (earliest.getUTCDay() + 6) % 7;
        weekStartUpdate = new Date(earliest.getTime() - dow * 86400000);
      }

      await tx.mealSchedule.updateMany({
        where: { id, organizationId },
        data: {
          isPublished: true,
          publishedAt: new Date(),
          ...(weekStartUpdate ? { weekStart: weekStartUpdate } : {}),
        },
      });
    });
    // Freeze the just-published entries as the snapshot students read.
    await this.captureSnapshot(id, organizationId);
    return this.findById(id, organizationId) as Promise<MealScheduleEntity>;
  }

  // Issue 2: revert a published schedule back to draft (inverse of publish).
  // Additive — mirrors publish(); idempotent and org-isolated.
  async revert(
    id: string,
    organizationId: string,
    hide = false,
  ): Promise<MealScheduleEntity> {
    // Issue 1 (default): reverting to draft must NOT erase what students see.
    // Keep publishedAt + publishedSnapshot intact (students keep reading the
    // last published version); only clear the admin-UI isPublished flag so
    // the admin can edit the live draft entries and re-publish.
    //
    // Pass 15 (FR-SCHX-003, hide=true): full UNPUBLISH — also clear
    // publishedAt so the student read path (gated on publishedAt != null)
    // hides the week. publishedSnapshot is deliberately RETAINED in the row,
    // so the last published state stays recoverable until the next publish.
    const result = await this.prisma.mealSchedule.updateMany({
      where: { id, organizationId },
      data: { isPublished: false, ...(hide ? { publishedAt: null } : {}) },
    });
    if (result.count === 0) throw new NotFoundException('Schedule not found');
    return this.findById(id, organizationId) as Promise<MealScheduleEntity>;
  }

  async clone(
    sourceId: string,
    organizationId: string,
    targetWeekStart: Date,
    replaceExisting = false,
  ): Promise<MealScheduleEntity> {
    const source = await this.findById(sourceId, organizationId);
    if (!source) throw new NotFoundException('Source schedule not found');

    const offsetMs = targetWeekStart.getTime() - source.weekStart.getTime();

    return this.prisma.$transaction(async (tx) => {
      // Pass 15 (FR-SCHX-005): the target week may already have a schedule
      // (@@unique(groupId, weekStart) previously surfaced as a raw P2002/500).
      // Reject explicitly unless the caller opted into replacement.
      const existing = await tx.mealSchedule.findFirst({
        where: {
          groupId: source.groupId,
          organizationId,
          weekStart: targetWeekStart,
        },
        select: { id: true },
      });
      if (existing) {
        if (!replaceExisting) {
          throw new ConflictException({
            message:
              'A schedule already exists for the target week. Send replace: true to overwrite it.',
            code: 'SCHEDULE_EXISTS',
            errors: {
              targetWeekStartDate: 'Target week already has a schedule',
            },
          });
        }
        // Entries cascade with the schedule row.
        await tx.mealSchedule.delete({ where: { id: existing.id } });
      }

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
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
                  menuItems: e.menuItems ?? [],
                  price: e.price ?? null,
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
