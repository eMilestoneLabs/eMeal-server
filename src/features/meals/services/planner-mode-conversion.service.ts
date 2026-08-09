import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { resolvePublishedDayEntries } from '../../../common/utils/published-day.util';
import type { PublishedDayEntry } from '../../../common/utils/published-day.util';
import {
  getTodayInTimezone,
  toUtcMidnight,
  formatUtcDate,
} from '../../../common/utils/date.utils';
import type { RealtimeEventsService } from '../../../realtime/services/realtime-events.service';
import { freezeLegacyPublishedSnapshot } from '../../../common/utils/published-snapshot.util';

/** Planner modes. Mutually exclusive — exactly one is active while meals are ON. */
export type PlannerMode = 'WEEKLY' | 'DAY_WISE';

/**
 * One draft planner cell (meal × calendar date). Every field except the
 * identity triple is an OVERRIDE: `null`/`[]` means "inherit the Master Meal
 * Template", which is what keeps the master a SOFT template.
 */
interface DraftCell {
  mealId: string;
  date: Date; // UTC midnight of the real calendar date
  dayOfWeek: number; // 0=Mon … 6=Sun, derived from `date`
  openTime: string | null;
  closeTime: string | null;
  description: string | null;
  preferencesEnabled: boolean | null;
  enabledPreferences: string[];
  enabledPreferenceGroupIds: string[];
  menuItems: string[];
  price: number | null;
}

const MS_PER_DAY = 86_400_000;

/** 0=Mon … 6=Sun (JS getUTCDay is 0=Sun). */
function dayOfWeekOf(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

/** Monday (UTC midnight) of the ISO week containing [date]. */
function weekStartOf(date: Date): Date {
  return new Date(date.getTime() - dayOfWeekOf(date) * MS_PER_DAY);
}

/**
 * PlannerModeConversionService — Live-Test-15 ISSUE-1 (user-locked).
 *
 * ONE responsibility: when an admin switches a group between Weekly Meal Mode
 * and Day-Wise Meal Mode, build the target mode's DRAFT planner.
 *
 * ── The invariant this service exists to protect ───────────────────────────
 * There is exactly ONE currently effective permanent published schedule per
 * group. Switching planner mode creates a DRAFT in the target mode and MUST
 * NEVER replace that published schedule. Students, attendance, billing,
 * vacation, corrections, reports, analytics, exports and notifications keep
 * using the previous published schedule until the admin publishes the new
 * mode. Only Publish may replace it.
 *
 * Concretely: this service writes `ScheduleEntry` rows (the draft layer) and
 * sets `isPublished = false`. It NEVER touches `publishedSnapshot` or
 * `publishedAt` — the two columns every read path gates on.
 *
 * ── Seeding rules (user-locked) ────────────────────────────────────────────
 *   WEEKLY → DAY_WISE
 *     Today, Tomorrow ← currently effective PUBLISHED configuration of those
 *                       two calendar dates.
 *   DAY_WISE → WEEKLY
 *     Today, Tomorrow ← currently effective PUBLISHED configuration.
 *     Remaining 5 weekdays ← Master Meal Template (fresh inheritance).
 *
 * An obsolete previously-published matrix for the target mode is deliberately
 * NOT restored: historical published rows stay intact for attendance/billing/
 * report integrity, but they never become the next planner draft.
 *
 * ── Why master-seeded cells are written as pure inheritance ────────────────
 * A master-seeded cell stores NO override values (all null/[]). The Master
 * Meal Template is a soft template, so an un-overridden cell must keep
 * tracking it. Materialising the master's current values into explicit
 * overrides would silently freeze them forever and break that contract.
 * Published-seeded cells copy their overrides VERBATIM (nulls included), so a
 * cell that inherited the master when it was published keeps inheriting it.
 *
 * ── Cost ───────────────────────────────────────────────────────────────────
 * This runs only on a REAL mode flip — a rare, cold admin mutation, never on
 * a read path. Its reads are a single `Promise.all` wave and its writes are
 * one transaction. Zero impact on any hot endpoint's query-wave budget.
 */
@Injectable()
export class PlannerModeConversionService {
  private readonly logger = new Logger(PlannerModeConversionService.name);

  /** Practical upper bound on meals per group (mirrors SchedulesService). */
  private static readonly MAX_GROUP_MEALS = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional()
    @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
  ) {}

  /**
   * Build the target mode's draft. Fail-soft by contract: the caller
   * (`GroupsService.updateGroup`) has already committed the mode flip, so a
   * conversion failure is logged and swallowed rather than rolling back a
   * saved configuration. The planner still opens — it simply shows the
   * pre-existing draft until the admin edits or the next conversion runs.
   */
  async convertOnModeChange(params: {
    groupId: string;
    organizationId: string;
    actorId: string;
    targetMode: PlannerMode;
    requestId?: string;
  }): Promise<void> {
    const { groupId, organizationId, actorId, targetMode, requestId } = params;
    try {
      const { today, tomorrow } = await this.resolveOrgDates(organizationId);

      // ── ONE parallel read wave ────────────────────────────────────────────
      // The two published lookups are independent of each other and of the
      // master catalogue, so they never become sequential awaits.
      const [publishedToday, publishedTomorrow, masterMealIds] =
        await Promise.all([
          resolvePublishedDayEntries(this.prisma as any, {
            groupId,
            organizationId,
            dateStr: formatUtcDate(today),
          }),
          resolvePublishedDayEntries(this.prisma as any, {
            groupId,
            organizationId,
            dateStr: formatUtcDate(tomorrow),
          }),
          this.activeMasterMealIds(groupId, organizationId),
        ]);

      if (masterMealIds.length === 0) {
        // Nothing to plan with — leave whatever draft exists untouched.
        return;
      }

      const cells =
        targetMode === 'DAY_WISE'
          ? this.buildDayWiseDraft({
              today,
              tomorrow,
              publishedToday,
              publishedTomorrow,
              masterMealIds,
            })
          : this.buildWeeklyDraft({
              today,
              tomorrow,
              publishedToday,
              publishedTomorrow,
              masterMealIds,
            });

      if (cells.length === 0) return;

      const weeksTouched = await this.persistDraft(
        cells,
        groupId,
        organizationId,
      );

      this.audit.log({
        organizationId,
        actorId,
        targetId: groupId,
        targetType: 'Group',
        action: 'update',
        metadata: {
          plannerModeConverted: targetMode,
          draftCells: cells.length,
          weekRowsTouched: weeksTouched,
          seededFromPublished:
            publishedToday.size > 0 || publishedTomorrow.size > 0,
          publishedScheduleUntouched: true,
        },
        requestId,
      });

      // Repaint any other open admin session's planner. Fire-and-forget.
      this.realtime?.emitScheduleUpdated(organizationId, {
        organizationId,
        groupId,
        scheduleId: '',
        weekStart: weekStartOf(today).toISOString(),
        isPublished: false,
      });
    } catch (err) {
      // Never fail an already-committed group configuration save. Logged, not
      // swallowed silently, and self-healing: the next mode flip re-converts.
      this.logger.error(
        `Planner mode conversion failed for group=${groupId} org=${organizationId} target=${targetMode} — group mode was saved; draft not rebuilt`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  /** Today + tomorrow as UTC-midnight dates in the ORG's timezone (guidebook org-today law). */
  private async resolveOrgDates(
    organizationId: string,
  ): Promise<{ today: Date; tomorrow: Date }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = toUtcMidnight(
      getTodayInTimezone(org?.timezone ?? 'Asia/Kolkata'),
    );
    return { today, tomorrow: new Date(today.getTime() + MS_PER_DAY) };
  }

  /**
   * Active master meal IDs for the group, in the planner's display order.
   *
   * IDs are all this service needs: a master-seeded cell stores NO override
   * values, so nothing else from the meal row is ever copied. Querying them
   * directly (rather than through `MealsRepository`) keeps this service
   * dependent on Prisma alone — `MealsModule` already imports `GroupsModule`,
   * so a repository dependency here would make the two modules circular.
   *
   * Filter mirrors `MealsRepository.findByGroup` exactly: DELETED meals leave
   * the template permanently (`deletedAt: null`) and DISABLED meals are
   * excluded from the planner (`isActive: true`). Ordering mirrors
   * FR-MEAL-007 — chronological by attendance window, admin order as
   * tie-breaker — so the draft's meal order matches every other screen.
   */
  private async activeMasterMealIds(
    groupId: string,
    organizationId: string,
  ): Promise<string[]> {
    const meals = await this.prisma.meal.findMany({
      where: {
        groupId,
        organizationId, // CRITICAL: tenant isolation
        deletedAt: null,
        isActive: true,
      },
      select: { id: true },
      orderBy: [
        { attendanceWindowOpen: 'asc' },
        { order: 'asc' },
      ],
      take: PlannerModeConversionService.MAX_GROUP_MEALS,
    });
    return meals.map((m) => m.id);
  }

  // ── Cell builders (pure) ───────────────────────────────────────────────────

  /** A published entry → a draft cell, copying overrides verbatim. */
  private cellFromPublished(
    mealId: string,
    date: Date,
    e: PublishedDayEntry,
  ): DraftCell {
    return {
      mealId,
      date,
      dayOfWeek: dayOfWeekOf(date),
      openTime: e.openTime ?? null,
      closeTime: e.closeTime ?? null,
      description: e.description ?? null,
      preferencesEnabled: e.preferencesEnabled ?? null,
      enabledPreferences: e.enabledPreferences ?? [],
      enabledPreferenceGroupIds: e.enabledPreferenceGroupIds ?? [],
      menuItems: e.menuItems ?? [],
      price: e.price ?? null,
    };
  }

  /** A master meal → a draft cell that INHERITS everything (no overrides). */
  private cellFromMaster(mealId: string, date: Date): DraftCell {
    return {
      mealId,
      date,
      dayOfWeek: dayOfWeekOf(date),
      openTime: null,
      closeTime: null,
      description: null,
      preferencesEnabled: null,
      enabledPreferences: [],
      enabledPreferenceGroupIds: [],
      menuItems: [],
      price: null,
    };
  }

  /**
   * Cells for ONE calendar date: the published configuration when the date has
   * one, else fresh master inheritance. Published entries whose master meal has
   * since been deleted/disabled are dropped (same rule as
   * `SchedulesService.buildEntryData`) so a stale meal can never re-enter a
   * draft — while every currently active meal is always present, so the admin
   * can configure each one immediately.
   */
  private cellsForDate(
    date: Date,
    published: Map<string, PublishedDayEntry>,
    masterMealIds: string[],
  ): DraftCell[] {
    return masterMealIds.map((id) => {
      const e = published.get(id);
      return e
        ? this.cellFromPublished(id, date, e)
        : this.cellFromMaster(id, date);
    });
  }

  /** WEEKLY → DAY_WISE: exactly Today + Tomorrow, date-based. */
  private buildDayWiseDraft(p: {
    today: Date;
    tomorrow: Date;
    publishedToday: Map<string, PublishedDayEntry>;
    publishedTomorrow: Map<string, PublishedDayEntry>;
    masterMealIds: string[];
  }): DraftCell[] {
    return [
      ...this.cellsForDate(p.today, p.publishedToday, p.masterMealIds),
      ...this.cellsForDate(p.tomorrow, p.publishedTomorrow, p.masterMealIds),
    ];
  }

  /**
   * DAY_WISE → WEEKLY: the seven weekday cells of the CURRENT week.
   *
   * Today and Tomorrow inherit the currently published configuration; the other
   * five initialise from the Master Meal Template. The weekly matrix is
   * weekday-based, so when today is Sunday its "tomorrow" (next calendar
   * Monday) seeds the current week's MONDAY column — the matrix stays a single
   * Mon–Sun row, exactly as Weekly mode has always stored it.
   */
  private buildWeeklyDraft(p: {
    today: Date;
    tomorrow: Date;
    publishedToday: Map<string, PublishedDayEntry>;
    publishedTomorrow: Map<string, PublishedDayEntry>;
    masterMealIds: string[];
  }): DraftCell[] {
    const weekStart = weekStartOf(p.today);
    const seeded = new Map<number, Map<string, PublishedDayEntry>>([
      [dayOfWeekOf(p.today), p.publishedToday],
      [dayOfWeekOf(p.tomorrow), p.publishedTomorrow],
    ]);

    const cells: DraftCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(weekStart.getTime() + dow * MS_PER_DAY);
      cells.push(
        ...this.cellsForDate(
          date,
          seeded.get(dow) ?? new Map(),
          p.masterMealIds,
        ),
      );
    }
    return cells;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * Write the draft, grouped by the ISO week each CALENDAR DATE belongs to.
   *
   * Day-Wise Today+Tomorrow are two consecutive calendar dates, so on a Sunday
   * they straddle two `MealSchedule` rows (`@@unique([groupId, weekStart])`).
   * That is a storage detail, never a business restriction: both rows are
   * written inside ONE transaction, so a failure can never leave half a
   * conversion committed.
   *
   * The previous draft of every touched week is cleared first, so a stale
   * weekly draft day can never survive into a Day-Wise plan (and vice versa).
   * `publishedSnapshot` / `publishedAt` are never written — the effective
   * published schedule stays operational until the admin publishes.
   *
   * Returns the number of week rows touched.
   */
  private async persistDraft(
    cells: DraftCell[],
    groupId: string,
    organizationId: string,
  ): Promise<number> {
    const byWeek = new Map<number, DraftCell[]>();
    for (const c of cells) {
      const key = weekStartOf(c.date).getTime();
      const bucket = byWeek.get(key);
      if (bucket) bucket.push(c);
      else byWeek.set(key, [c]);
    }

    await this.prisma.$transaction(async (tx) => {
      for (const [weekMs, weekCells] of byWeek) {
        const weekStart = new Date(weekMs);
        // Org-filtered lookup (same idiom as SchedulesRepository.clone) so a
        // foreign-org row can never be adopted by a groupId collision.
        const existing = await tx.mealSchedule.findFirst({
          where: { groupId, organizationId, weekStart },
          select: { id: true, publishedAt: true, publishedSnapshot: true },
        });

        let scheduleId: string;
        if (existing) {
          scheduleId = existing.id;
          // ── LEGACY PUBLISHED ROWS: FREEZE BEFORE CLEARING ─────────────────
          // `publishedSnapshot` was added AFTER the first releases, and
          // `scheduleFromSnapshot` documents the consequence: a published row
          // with a null snapshot serves its LIVE `entries` as the published
          // schedule, and "every week published by an older build has a null
          // snapshot". Clearing the draft on such a row would therefore DELETE
          // the effective published schedule — irreversible data loss and a
          // direct breach of "a draft must never modify the published
          // schedule".
          //
          // So freeze the current published view into the column that
          // represents it FIRST. This is not a change to what members see: the
          // snapshot is built from exactly the rows that were being served.
          // Runs once per legacy row, inside the same transaction, and is
          // skipped entirely for every row that already has a snapshot.
          await freezeLegacyPublishedSnapshot(tx, existing);

          // Auto-Draft. publishedSnapshot / publishedAt deliberately untouched.
          await tx.mealSchedule.update({
            where: { id: scheduleId },
            data: { isPublished: false },
          });
          await tx.scheduleEntry.deleteMany({ where: { scheduleId } });
        } else {
          const created = await tx.mealSchedule.create({
            data: {
              organizationId,
              groupId,
              weekStart,
              isPublished: false,
            },
            select: { id: true },
          });
          scheduleId = created.id;
        }

        await tx.scheduleEntry.createMany({
          data: weekCells.map((c) => ({
            scheduleId,
            mealId: c.mealId,
            dayOfWeek: c.dayOfWeek,
            date: c.date,
            mealName: null, // non-overridable — always inherits the master
            imageUrl: null, // non-overridable — always inherits the master
            notes: null,
            description: c.description,
            openTime: c.openTime,
            closeTime: c.closeTime,
            preferencesEnabled: c.preferencesEnabled,
            enabledPreferences: c.enabledPreferences,
            enabledPreferenceGroupIds: c.enabledPreferenceGroupIds,
            menuItems: c.menuItems,
            price: c.price,
          })),
          skipDuplicates: true,
        });
      }
    });

    return byWeek.size;
  }

}
