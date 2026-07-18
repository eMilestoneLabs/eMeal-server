/**
 * vacation-coverage.util.ts — Pass 11 (SRS FR-VACX-003/006, Module 26).
 *
 * Single source of truth for "is this member on vacation for (date, meal)?"
 * used by guest hosting (FR-VACX-008), the opt-out system-default sweep
 * (never auto-bill a vacationing member) and the vacation lifecycle sweep.
 *
 * Two vacation modes coexist (FR-VACX-001):
 *   • Dated requests — an APPROVED VacationRequest covering the date governs,
 *     with optional meal-granular boundaries (FR-VACX-003): on the start date
 *     only meals opening AT/AFTER the startSlotKey meal's open time are
 *     covered; on the end date only meals opening AT/BEFORE the endSlotKey
 *     meal's open time. Interior days are fully covered.
 *   • Instant toggle — when NO approved request governs the date, the user's
 *     isVacationMode flag covers the whole day (legacy self-service mode).
 *
 * Fail-safe direction: unknown open times / missing slot meals resolve to
 * COVERED — "covered" can only ever suppress auto-billing or guest hosting,
 * never create a charge.
 *
 * Plain functions taking a Prisma-like client — zero DI/module wiring, so
 * callers (services, workers) adopt it without constructor changes.
 */

import { resolvePublishedDayEntries } from './published-day.util';

export interface VacationRangeLite {
  groupId: string | null; // null = org-level request (applies to all groups)
  startDate: Date;
  endDate: Date;
  startSlotKey: string | null;
  endSlotKey: string | null;
}

function hhmmToMinutes(t: string | null | undefined): number | null {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Pure boundary math: does an approved request cover (dateUtc, meal)?
 * `mealOpenMinutes` null (windowless meal) or an unresolvable boundary slot
 * resolves to covered (fail-safe).
 */
export function requestCoversMeal(
  req: VacationRangeLite,
  dateUtc: Date,
  mealOpenMinutes: number | null,
  slotOpenMinutes: (slotKey: string) => number | null,
): boolean {
  const t = dateUtc.getTime();
  if (t < req.startDate.getTime() || t > req.endDate.getTime()) return false;

  const isStartDay = t === req.startDate.getTime();
  const isEndDay = t === req.endDate.getTime();
  if ((!isStartDay || !req.startSlotKey) && (!isEndDay || !req.endSlotKey)) {
    return true; // interior day, or boundary day without a slot bound
  }
  if (mealOpenMinutes === null) return true; // windowless meal → fail-safe

  if (isStartDay && req.startSlotKey) {
    const bound = slotOpenMinutes(req.startSlotKey);
    if (bound !== null && mealOpenMinutes < bound) return false; // before vacation starts
  }
  if (isEndDay && req.endSlotKey) {
    const bound = slotOpenMinutes(req.endSlotKey);
    if (bound !== null && mealOpenMinutes > bound) return false; // after vacation ends
  }
  return true;
}

type PrismaLike = {
  vacationRequest: {
    findMany: (args: unknown) => Promise<any[]>;
  };
  meal: {
    findMany: (args: unknown) => Promise<any[]>;
  };
};

/**
 * Batch resolver: which of `candidates` are on vacation for (group, date,
 * meal)? One indexed query over approved requests + at most one small meal
 * lookup for boundary slot open times.
 */
export async function getVacationCoveredUserIds(
  prisma: PrismaLike,
  params: {
    organizationId: string;
    groupId: string;
    dateUtc: Date;
    /** HH:mm open time of the meal being evaluated (null = windowless). */
    mealOpenTime: string | null;
    candidates: Array<{ userId: string; isVacationMode: boolean }>;
  },
): Promise<Set<string>> {
  const { organizationId, groupId, dateUtc, candidates } = params;
  if (candidates.length === 0) return new Set();

  const userIds = candidates.map((c) => c.userId);
  const requests: Array<{
    userId: string;
    groupId: string | null;
    startDate: Date;
    endDate: Date;
    startSlotKey: string | null;
    endSlotKey: string | null;
  }> = await prisma.vacationRequest.findMany({
    where: {
      organizationId,
      userId: { in: userIds },
      status: 'approved',
      deletedAt: null,
      startDate: { lte: dateUtc },
      endDate: { gte: dateUtc },
    },
    select: {
      userId: true,
      groupId: true,
      startDate: true,
      endDate: true,
      startSlotKey: true,
      endSlotKey: true,
    },
  });

  // Boundary slot keys we must translate into open times (rare path).
  const boundarySlotKeys = new Set<string>();
  for (const r of requests) {
    if (r.startSlotKey && r.startDate.getTime() === dateUtc.getTime()) {
      boundarySlotKeys.add(r.startSlotKey);
    }
    if (r.endSlotKey && r.endDate.getTime() === dateUtc.getTime()) {
      boundarySlotKeys.add(r.endSlotKey);
    }
  }
  const slotOpens = new Map<string, number | null>();
  if (boundarySlotKeys.size > 0) {
    const slotMeals: Array<{
      id: string;
      slotKey: string;
      attendanceWindowOpen: string | null;
    }> = await prisma.meal.findMany({
      where: { groupId, slotKey: { in: [...boundarySlotKeys] } },
      select: { id: true, slotKey: true, attendanceWindowOpen: true },
    });
    // Live-Test-11 ISSUE-005: boundary math must run on the SAME clock the
    // member sees — the published day's window overrides (single source of
    // truth, LT-9) win over the master window. Master remains the fallback
    // for non-planner groups / unscheduled meals; failures keep the master
    // path (fail-safe direction unchanged).
    let dayEntries: Map<string, { openTime: string | null }> = new Map();
    try {
      dayEntries = (await resolvePublishedDayEntries(prisma as any, {
        groupId,
        organizationId,
        dateStr: dateUtc.toISOString().slice(0, 10),
      })) as unknown as Map<string, { openTime: string | null }>;
    } catch {
      /* master fallback */
    }
    for (const m of slotMeals) {
      const effOpen = dayEntries.get(m.id)?.openTime ?? m.attendanceWindowOpen;
      slotOpens.set(m.slotKey, hhmmToMinutes(effOpen));
    }
  }

  const mealOpenMinutes = hhmmToMinutes(params.mealOpenTime);
  const slotOpenLookup = (slotKey: string): number | null =>
    slotOpens.get(slotKey) ?? null;

  const byUser = new Map<string, VacationRangeLite[]>();
  for (const r of requests) {
    // Group-scoped requests only govern their own group; org-level (null)
    // requests govern every group.
    if (r.groupId && r.groupId !== groupId) continue;
    const list = byUser.get(r.userId) ?? [];
    list.push(r);
    byUser.set(r.userId, list);
  }

  const covered = new Set<string>();
  for (const c of candidates) {
    const reqs = byUser.get(c.userId);
    if (reqs && reqs.length > 0) {
      if (
        reqs.some((r) =>
          requestCoversMeal(r, dateUtc, mealOpenMinutes, slotOpenLookup),
        )
      ) {
        covered.add(c.userId);
      }
      // An approved request governs the date — the flag is ignored for it
      // (activation/resume lag can never change billing outcomes).
      continue;
    }
    // No dated request governs this date → the instant toggle covers whole days.
    if (c.isVacationMode) covered.add(c.userId);
  }
  return covered;
}
