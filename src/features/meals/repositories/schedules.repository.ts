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
import {
  resolvePublishedDayEntries,
  PublishedDayEntry,
  PublishedPreferenceSnapshot,
} from '../../../common/utils/published-day.util';
import { freezeLegacyPublishedSnapshot } from '../../../common/utils/published-snapshot.util';

/**
 * P-01: the shape `PreferencesService.getEffectiveGroupsForMeals()` returns.
 * Declared structurally (not imported) so the data layer keeps zero dependency
 * on a feature service — the publish-time resolver is injected as a function.
 */
export interface EffectivePublishedGroup {
  id: string;
  label: string;
  description?: string | null;
  order: number;
  selectionType: string;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  quantityEnabled: boolean;
  vegOnly: boolean;
  visibleWhen?: { groupId: string; optionKey: string } | null;
  options?: Array<{
    id: string;
    key: string;
    label: string;
    emoji: string | null;
    color: string | null;
    isVeg: boolean;
    priceDelta: number;
    minQty: number;
    maxQty: number;
    order: number;
  }>;
}

/** The planner mode a schedule is published in (P-01). */
export type PublishedPlannerMode = 'WEEKLY' | 'DAY_WISE';

/**
 * Everything the publish path needs from Module 36, injected as ONE object so
 * the data layer keeps zero dependency on a feature service.
 *
 * `narrowByDay` is deliberately supplied rather than re-implemented: the
 * per-day narrowing rule (preferences OFF for the day, or a non-empty
 * preference-group subset) is business logic that already exists exactly once,
 * in `PreferencesService.applyDayOverride`. Two copies of that rule could
 * drift — and a drift between two preference resolvers is precisely what
 * caused P-01. One rule, one owner.
 */
export interface PublishPreferenceContext {
  /** Batched effective-group lookup for the meals being published. */
  resolve: (
    mealIds: string[],
  ) => Promise<Map<string, EffectivePublishedGroup[]>>;
  /** The canonical per-day narrowing rule (PreferencesService.applyDayOverride). */
  narrowByDay: (
    groups: EffectivePublishedGroup[],
    override: {
      preferencesEnabled: boolean | null;
      enabledPreferenceGroupIds: string[];
    },
  ) => EffectivePublishedGroup[];
}

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
            // Live-Test-5 ISSUE-5: lets the ADMIN (live/draft) view filter
            // out entries whose master meal was soft-deleted (archived).
            isActive: true,
            // P-01: master preference state — read ONLY to build the frozen
            // preference block at publish time (snapshotFromEntries).
            preferencesEnabled: true,
            enabledPreferences: true,
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
            preferencesEnabled: raw.meal.preferencesEnabled ?? undefined,
            enabledPreferences: raw.meal.enabledPreferences ?? undefined,
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

  /**
   * P-01: a PUBLISHED row needs a re-publish when its configuration was never
   * frozen (null snapshot, or any entry missing the marker). Drafts that were
   * never published are not flagged — there is nothing published to freeze.
   */
  private static needsRepublish(raw: any): boolean {
    if (!raw?.publishedAt) return false;
    const snap = raw.publishedSnapshot;
    if (!Array.isArray(snap) || snap.length === 0) return true;
    return snap.some((e: any) => e?.configurationFrozen !== true);
  }

  private buildScheduleEntity(
    raw: any,
    /**
     * ISSUE-001 (Live-Test-13): keep entries whose master meal was archived.
     *
     * Set ONLY by the published/student read path ([scheduleFromSnapshot]'s
     * legacy fallback). A row published before the `publishedSnapshot` column
     * existed has a null snapshot, so that fallback rebuilds from the LIVE
     * entries — and applying the draft-view archive filter there deleted the
     * meal from the member's weekly menu the instant it was disabled/deleted,
     * with no publish. Every previously published production week is exactly
     * that case, which is why fixing only the snapshot path never held.
     * For a PUBLISHED row the live entries ARE the published state, so they
     * must be served whole until the admin republishes.
     */
    includeArchivedMeals = false,
  ): MealScheduleEntity {
    // Live-Test-5 ISSUE-5 (auto-draft on master-meal delete): the LIVE/draft
    // view never shows entries whose master meal was soft-deleted — the
    // planner instantly reflects the deletion ("auto draft"), while members
    // keep reading the frozen publishedSnapshot until the admin re-publishes.
    // Entries without a meal join (snapshot rebuilds) are kept as-is.
    const entries = SchedulesRepository.sortEntriesChronologically(
      (raw.entries ?? [])
        .filter(
          (e: any) =>
            includeArchivedMeals || !e.meal || e.meal.isActive !== false,
        )
        .map((e: any) => this.buildEntryEntity(e)),
    );
    return new MealScheduleEntity({
      id: raw.id,
      organizationId: raw.organizationId,
      groupId: raw.groupId,
      weekStart: raw.weekStart,
      isPublished: raw.isPublished,
      publishedAt: raw.publishedAt ?? null,
      entries,
      requiresRepublish: SchedulesRepository.needsRepublish(raw),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  }

  // ── Issue 1: published snapshot helpers ───────────────────────────────────

  /**
   * P-01 §"RESOLVE COMPLETE EFFECTIVE CONFIGURATION": resolve the frozen
   * preference block for ONE entry from the master groups supplied by the
   * publish-time resolver, applying the SAME precedence the /meals/today
   * overlay applies at read time (per-day override wins, empty subset =
   * inherit all master groups). Returns null when no resolver ran, which keeps
   * the entry unfrozen rather than inventing an empty configuration.
   */
  private static resolvePublishedPreference(
    e: ScheduleEntryEntity,
    masterGroups: EffectivePublishedGroup[] | undefined,
    narrowByDay: PublishPreferenceContext['narrowByDay'],
  ): PublishedPreferenceSnapshot | null {
    if (masterGroups === undefined) return null;
    const enabled = e.preferencesEnabled ?? e.meal?.preferencesEnabled ?? false;
    // Effective flat tags — per-day override else master. Frozen INDEPENDENTLY
    // of mode on purpose: the admin attendance / staff-attendance / guest
    // sheets read `enabledPreferences` on its own (staff-attendance even falls
    // back to the GROUP-level list when it is empty), so blanking it in group
    // mode would silently change those screens. `mode` carries the
    // Standalone-vs-Group distinction; the tag list stays baseline-faithful.
    const tags =
      (e.enabledPreferences ?? []).length > 0
        ? e.enabledPreferences
        : (e.meal?.enabledPreferences ?? []);
    if (!enabled) {
      return { enabled: false, mode: 'standalone', tags, groups: [] };
    }
    // Per-day narrowing is delegated to the ONE canonical implementation
    // (PreferencesService.applyDayOverride) — never re-implemented here.
    const groups = narrowByDay(masterGroups, {
      preferencesEnabled: e.preferencesEnabled,
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
    }).map((g) => ({
      id: g.id,
      label: g.label,
      description: g.description ?? null,
      order: g.order,
      selectionType: g.selectionType,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      required: g.required,
      quantityEnabled: g.quantityEnabled,
      vegOnly: g.vegOnly,
      visibleWhen: g.visibleWhen ?? null,
      options: (g.options ?? []).map((o) => ({
        id: o.id,
        key: o.key,
        label: o.label,
        emoji: o.emoji ?? null,
        color: o.color ?? null,
        isVeg: o.isVeg,
        priceDelta: o.priceDelta,
        minQty: o.minQty,
        maxQty: o.maxQty,
        order: o.order,
      })),
    }));
    return {
      enabled: true,
      // Live-Test-8 ISSUE-001/002 parity: a meal with zero ACTIVE bindings is
      // in Standalone mode (suspended bindings are already filtered out by the
      // effective resolver that produced `masterGroups`).
      mode: groups.length > 0 ? 'group' : 'standalone',
      tags,
      groups,
    };
  }

  /**
   * Serialize live entries (with meal join) into the frozen published snapshot.
   *
   * P-01: when `prefsByMeal` is supplied the entry is stamped
   * `configurationFrozen` and carries the complete resolved `preference`
   * block, so operational readers never touch live master preference state
   * for this published day again.
   */
  private snapshotFromEntries(
    entries: ScheduleEntryEntity[],
    prefsByMeal?: Map<string, EffectivePublishedGroup[]>,
    plannerMode?: PublishedPlannerMode,
    narrowByDay?: PublishPreferenceContext['narrowByDay'],
  ): any[] {
    return entries.map((e) => ({
      ...(prefsByMeal
        ? {
            configurationFrozen: true,
            // P-01: the mode this day was PUBLISHED in — the Day-Wise
            // carry-forward reads this instead of the group's LIVE mode flag,
            // which flips before the new mode is ever published.
            ...(plannerMode ? { plannerMode } : {}),
            preference: SchedulesRepository.resolvePublishedPreference(
              e,
              prefsByMeal.get(e.mealId) ?? [],
              narrowByDay!,
            ),
          }
        : {}),
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
   *
   * Legacy rows published before this column existed have a null snapshot — for
   * them we fall back to the LIVE entries, served WHOLE (archived master meals
   * included) via `includeArchivedMeals`.
   *
   * HISTORY — read before changing this (ISSUE-001, Live-Test-13):
   * this fallback originally carried the note "safe: a published row cannot
   * also hold an unsynced draft, so live == published". That was TRUE when the
   * snapshot column landed, but the auto-draft triggers added later
   * (revertPublishedForMeal / revertPublishedForGroup, which flip a published
   * row to draft while it stays published-visible) INVALIDATED it — a published
   * row can now absolutely hold an unsynced draft. The stale note went
   * unrevised and was read as proof of safety for several sessions, while this
   * branch quietly applied the DRAFT view's archived-meal filter to the
   * member-facing published read. Every week published by an older build has a
   * null snapshot, so production always took this path: disabling or deleting a
   * master meal removed it from the member weekly menu instantly, with no
   * publish. Data created after the snapshot column exists never reproduces it.
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
        requiresRepublish: SchedulesRepository.needsRepublish(raw),
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
      });
    }
    // ISSUE-001: legacy (null-snapshot) published rows — serve the live
    // entries WHOLE, archived master meals included. This is the published
    // state members must keep until the admin reviews the auto-draft and
    // republishes; the publish self-heal drops them at that point.
    return this.buildScheduleEntity(raw, true);
  }

  /**
   * Live-Test-11 ISSUE-011: Global Meal Preference OFF is applied AT PUBLISH
   * TIME — every snapshot row's per-day preference config is forced off, so
   * members receive the preference-free week the moment the admin publishes
   * (and keep the previous published week untouched until then).
   */
  private stripSnapshotPreferences(snapshot: any[]): any[] {
    return snapshot.map((e) => ({
      ...e,
      preferencesEnabled: false,
      enabledPreferences: [],
      enabledPreferenceGroupIds: [],
      // P-01: Global OFF must also blank the FROZEN block, otherwise a frozen
      // snapshot would keep serving preference groups the admin switched off.
      ...(e.preference
        ? {
            preference: {
              enabled: false,
              mode: 'standalone' as const,
              tags: [],
              groups: [],
            },
          }
        : {}),
    }));
  }

  /**
   * Resolve the publish-time preference map for a set of entries. Returns
   * undefined when no resolver was supplied, which leaves the snapshot at
   * the entry unfrozen. ONE batched call — never per entry.
   */
  private static async resolvePrefs(
    entries: ScheduleEntryEntity[],
    prefs?: PublishPreferenceContext,
  ): Promise<Map<string, EffectivePublishedGroup[]> | undefined> {
    if (!prefs) return undefined;
    const mealIds = [...new Set(entries.map((e) => e.mealId))];
    if (mealIds.length === 0) return new Map();
    return prefs.resolve(mealIds);
  }

  /** Persist the published snapshot for a schedule from its current live entries. */
  private async captureSnapshot(
    id: string,
    organizationId: string,
    stripPreferences = false,
    resolvePreferences?: PublishPreferenceContext,
    plannerMode?: PublishedPlannerMode,
  ): Promise<void> {
    const full = await this.findById(id, organizationId);
    const prefs = await SchedulesRepository.resolvePrefs(
      full?.entries ?? [],
      resolvePreferences,
    );
    let snapshot = full
      ? this.snapshotFromEntries(
            full.entries,
            prefs,
            plannerMode,
            resolvePreferences?.narrowByDay,
          )
      : [];
    if (stripPreferences) snapshot = this.stripSnapshotPreferences(snapshot);
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
   *
   * Live-Test-8 ISSUE-004: optional [dateStr] (YYYY-MM-DD) resolves the
   * overlay for THAT calendar date instead of today — the admin guest sheet
   * books guests for arbitrary dates and must see the same published
   * day-effective preference set the member flow validates against. Omitted =
   * today in org timezone (existing behaviour, byte-identical).
   */
  async findTodayOverlay(
    groupId: string,
    organizationId: string,
    dateStr?: string,
  ): Promise<Map<string, PublishedDayEntry>> {
    // Target calendar date: explicit [dateStr] (ISSUE-004) or today in org tz.
    // The org lookup is skipped when the caller already supplies the date —
    // one query less on the guest-sheet path, identical result.
    let todayStr: string;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      todayStr = dateStr;
    } else {
      // Resolve org timezone (same source the attendance engine uses).
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      });
      const tz = org?.timezone ?? 'Asia/Kolkata';
      todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    }

    // Live-Test-9 ISSUE-002/003: the shared published-day resolver is now the
    // ONLY lookup — the same helper attendance marking, corrections, guests
    // and the sweeps use, so display and enforcement can never diverge. The
    // returned entries additionally carry the frozen master-meal snapshot
    // (`meal`) so /meals/today can keep rendering a meal that was archived
    // AFTER the schedule was published (ISSUE-002: published week stays fully
    // operational until republish).
    return resolvePublishedDayEntries(this.prisma, {
      groupId,
      organizationId,
      dateStr: todayStr,
    });
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
      // ISSUE-001 (Live-Test-12): ANY draft edit automatically converts the
      // planner to DRAFT — a PATCH that touches the week or its entries flips
      // isPublished off in the same transaction, so the admin UI can never
      // claim "Published" while the live entries differ from the frozen
      // snapshot. publishedAt + publishedSnapshot stay INTACT: members keep
      // reading the last published week until the admin re-publishes.
      if (data.weekStart !== undefined || data.entries !== undefined) {
        scheduleUpdate.isPublished = false;
      }

      if (Object.keys(scheduleUpdate).length > 0) {
        const result = await tx.mealSchedule.updateMany({
          where: { id, organizationId },
          data: scheduleUpdate,
        });
        if (result.count === 0) throw new NotFoundException('Schedule not found');
      }

      if (data.entries !== undefined) {
        if (data.replaceEntries) {
          // PERMANENT_ARCH: "DRAFT MUST NEVER MODIFY THE CURRENT PUBLISHED
          // SCHEDULE." A published row whose `publishedSnapshot` is NULL serves
          // its LIVE entries as the published schedule (scheduleFromSnapshot:
          // "every week published by an older build has a null snapshot"), so
          // clearing them here would destroy the published week with no publish
          // at all. Freeze the published view into the column that represents
          // it first — built from exactly the rows already being served, so
          // members see no change. No-op for rows that already have a snapshot.
          const publishedRow = await tx.mealSchedule.findFirst({
            where: { id, organizationId },
            select: { id: true, publishedAt: true, publishedSnapshot: true },
          });
          await freezeLegacyPublishedSnapshot(tx, publishedRow);
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

  /**
   * Live-Test-9 ISSUE-002: deleting a master meal flips every PUBLISHED
   * schedule that still carries it into DRAFT (isPublished=false) — the admin
   * planner immediately shows "unpublished changes" minus the deleted meal
   * (buildScheduleEntity's read-time archive filter), while publishedAt +
   * publishedSnapshot stay INTACT so members keep the last published week
   * fully operational until the admin republishes. The publish self-heal then
   * physically drops the stale entries and freezes the new snapshot.
   */
  async revertPublishedForMeal(
    mealId: string,
    organizationId: string,
  ): Promise<number> {
    const result = await this.prisma.mealSchedule.updateMany({
      where: {
        organizationId,
        isPublished: true,
        entries: { some: { mealId } },
      },
      data: { isPublished: false },
    });
    return result.count;
  }

  /**
   * ISSUE-001 (Live-Test-12): GROUP-scoped auto-draft — every published
   * planner of the group flips to DRAFT (snapshot + publishedAt intact, so
   * members keep the last published week). Used by the unconditional
   * auto-draft triggers (master meal delete / disable / re-enable): the
   * meal-scoped variant misses the re-enable case where a publish self-heal
   * already dropped the disabled meal's entries — no entry rows exist to
   * match, yet the admin must still be routed through review → republish
   * before the re-enabled meal reaches members.
   */
  async revertPublishedForGroup(
    groupId: string,
    organizationId: string,
  ): Promise<number> {
    const result = await this.prisma.mealSchedule.updateMany({
      where: { groupId, organizationId, isPublished: true },
      data: { isPublished: false },
    });
    return result.count;
  }

  /**
   * Live-Test-5 ISSUE-5: stale entries of one schedule whose master meal is
   * soft-deleted/disabled. Queried at the DB level because the entity view
   * (buildScheduleEntity) now hides them — the publish self-heal still needs
   * to find and physically drop them.
   */
  async findStaleEntries(
    scheduleId: string,
    organizationId: string,
  ): Promise<Array<{ id: string; mealId: string; mealName: string | null; dayOfWeek: number }>> {
    const rows = await this.prisma.scheduleEntry.findMany({
      where: {
        scheduleId,
        schedule: { organizationId },
        meal: { isActive: false },
      },
      select: {
        id: true,
        mealId: true,
        mealName: true,
        dayOfWeek: true,
        meal: { select: { name: true, displayName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      mealId: r.mealId,
      mealName: r.mealName ?? r.meal?.displayName ?? r.meal?.name ?? null,
      dayOfWeek: r.dayOfWeek,
    }));
  }

  async publish(
    id: string,
    organizationId: string,
    // ISSUE-011: true when the group's Global Meal Preferences are OFF.
    stripPreferences = false,
    // P-01: resolves the complete effective preference configuration to freeze.
    resolvePreferences?: PublishPreferenceContext,
    // P-01: the planner mode being published (frozen into the snapshot).
    plannerMode?: PublishedPlannerMode,
  ): Promise<MealScheduleEntity> {
    // Freeze the current live entries as the published snapshot students read.
    const current = await this.findById(id, organizationId);
    const prefs = await SchedulesRepository.resolvePrefs(
      current?.entries ?? [],
      resolvePreferences,
    );
    let snapshot = current
      ? this.snapshotFromEntries(
          current.entries,
          prefs,
          plannerMode,
          resolvePreferences?.narrowByDay,
        )
      : [];
    if (stripPreferences) snapshot = this.stripSnapshotPreferences(snapshot);
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
    // ISSUE-011: true when the group's Global Meal Preferences are OFF —
    // the captured snapshot publishes preference-free.
    stripPreferences = false,
    // P-01: resolves the complete effective preference configuration to freeze.
    resolvePreferences?: PublishPreferenceContext,
    // P-01: the planner mode being published (frozen into the snapshot).
    plannerMode?: PublishedPlannerMode,
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
    await this.captureSnapshot(
      id,
      organizationId,
      stripPreferences,
      resolvePreferences,
      plannerMode,
    );
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
