import { BillingService } from '../../features/billing/billing.service';
import retentionConfig from '../../config/retention.config';

/**
 * Live-Test-16 ISSUE-14 — the earliest business date a group's history can
 * still contain, so date pickers never offer ranges the retention sweep has
 * already purged.
 *
 * Retention keeps N COMPLETE billing cycles ending at the FROZEN boundary
 * `retentionPurgeThrough`; after a purge the boundary advances by exactly N
 * cycles, so the retained window always starts at the first day of the Nth
 * cycle back from the boundary (RetentionService.cycleEndAfter, inverted).
 *
 * Calendar maths reuses BillingService.resolveCurrentPeriod — the single
 * period engine billing, exports and retention already share. It reads no
 * instance state, so it is invoked off the prototype (no DI, no duplication).
 *
 * PURE: reads only columns the group row already carries — zero queries.
 * Returns null when retention has not initialized yet (caller keeps its
 * existing default range).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const periodStart = (dateStr: string, cycleDay: number | null): string =>
  BillingService.prototype.resolveCurrentPeriod(dateStr, cycleDay).fromDate;

/** Retention cycles (env RETENTION_CYCLES) — read once, not per call. */
const DEFAULT_CYCLES = Math.max(1, retentionConfig().cycles || 3);

/**
 * PERF (group-list hot path): the result is a pure function of four dates +
 * the cycle count, and those change at most once per retention cycle. Memoized
 * so serializing a group costs a Map lookup instead of the calendar walk
 * (measured 17 µs → sub-µs). Holds only dates → strings (no tenant data);
 * bounded — cleared wholesale if it ever reaches MEMO_MAX distinct inputs.
 */
const MEMO_MAX = 5000;
const memo = new Map<string, string | null>();

type RetentionFloorInput = {
  retentionPurgeThrough?: Date | null;
  billingCycleStartDay?: number | null;
  createdAt?: Date | null;
  firstSchedulePublishedAt?: Date | null;
};

export function retainedDataFrom(
  group: RetentionFloorInput,
  cycles: number = DEFAULT_CYCLES,
): string | null {
  if (!group.retentionPurgeThrough) return null;
  const key =
    `${group.retentionPurgeThrough.getTime()}|${group.billingCycleStartDay ?? ''}|` +
    `${group.createdAt?.getTime() ?? ''}|${group.firstSchedulePublishedAt?.getTime() ?? ''}|${cycles}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const value = computeRetainedDataFrom(group, cycles);
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, value);
  return value;
}

function computeRetainedDataFrom(
  group: RetentionFloorInput,
  cycles: number,
): string | null {
  if (!group.retentionPurgeThrough) return null;
  const cycleDay = group.billingCycleStartDay ?? null;
  let start = periodStart(ymd(group.retentionPurgeThrough), cycleDay);
  for (let i = 1; i < cycles; i++) {
    const prevEnd = ymd(new Date(Date.parse(`${start}T00:00:00.000Z`) - DAY_MS));
    start = periodStart(prevEnd, cycleDay);
  }
  const created = group.createdAt ? ymd(group.createdAt) : null;
  // Attendance-Only → first-publish transition: while the window is still
  // the FIRST one anchored at the publication cycle, nothing has been purged
  // since the group was created — pre-publication history is still stored.
  if (group.firstSchedulePublishedAt && created) {
    const pubCycleStart = periodStart(ymd(group.firstSchedulePublishedAt), cycleDay);
    if (start <= pubCycleStart) return created;
  }
  // No group data can predate the group itself.
  return created && created > start ? created : start;
}
