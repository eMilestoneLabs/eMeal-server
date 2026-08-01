import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../../audit/audit.service';
import { StorageService } from '../../storage/storage.service';
import { BillingService } from '../billing/billing.service';
import { NoticesService } from '../notices/notices.service';
import { QueueService } from '../../queue/queue.service';

function todayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toUtcMidnight(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * RetentionService — SRS Module 03 RPT-009/010/011 + RET-001..015.
 *
 * BILLING-CYCLE-ALIGNED retention: retain N COMPLETE billing cycles per group.
 *
 *   Phase 1  the purge boundary (`retentionPurgeThrough`) is FROZEN on the
 *            group row as a real CYCLE END — never `createdAt + 3 months`,
 *            never a drifting `now + 3 months`. It cannot move forward just
 *            because a sweep ran late or retried, so the ACTIVE cycle is
 *            structurally impossible to purge.
 *   Phase 2  during the final `reminderDays` BEFORE that boundary the admins
 *            get ONE warning a day, while the data still exists. There is no
 *            post-cycle grace period — the advance warning replaces it.
 *   Phase 3  once the boundary has passed, the outstanding span is
 *            AUTO-finalized + locked (RET-007).
 *   Phase 3b HARD FINANCIAL GATE — the finalized period's immutable
 *            per-member `closingBalance` must equal what the next cycle will
 *            open with. Mismatch, missing snapshot or error => NO DELETE.
 *   Phase 5  a complete Excel workbook + PDF summary of everything about to
 *            be removed is generated and stored in MinIO (RET-008/009/010,
 *            RPT-010 — download is NOT a purge precondition), every admin is
 *            notified, the live rows are permanently deleted, and the next
 *            review is scheduled exactly RETENTION_MONTHS later (RET-011/012/015).
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly billing: BillingService,
    private readonly notices: NoticesService,
    private readonly queue: QueueService,
  ) {}

  private cfg(key: string, fallback: number): number {
    return this.config.get<number>(`retention.${key}`) ?? fallback;
  }

  // ── Sweep entry point (invoked by the system-default worker) ───────────────

  async sweep(): Promise<void> {
    // Only groups actually due (or never initialized) are fetched — groups
    // inside their retention window cost the sweep zero rows every 6 hours.
    // Billing-cycle retention: a group is worth loading only when its frozen
    // boundary is uninitialized, or close enough that the 7-day warning window
    // may have opened. Everything else costs the sweep zero rows.
    const warnHorizon = new Date(
      Date.now() + this.cfg('reminderDays', 7) * 24 * 60 * 60 * 1000,
    );
    const groups = await this.prisma.group.findMany({
      where: {
        isActive: true,
        OR: [
          { retentionPurgeThrough: null }, // bootstrap on first touch
          { retentionPurgeThrough: { lte: warnHorizon } },
        ],
      },
      select: {
        id: true,
        organizationId: true,
        name: true,
        adminId: true,
        createdAt: true,
        mealPricingEnabled: true,
        billingCycleStartDay: true,
        retentionPurgeThrough: true,
        organization: { select: { timezone: true } },
      },
    });
    for (const g of groups) {
      try {
        await this.processGroup(g);
      } catch (err) {
        // One bad group never blocks the rest (fail-safe).
        this.logger.error(
          `Retention sweep failed group=${g.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── Billing-cycle-aligned retention helpers ───────────────────────────────

  /**
   * Advances `cycles` COMPLETE billing cycles forward from the cycle that
   * contains [fromDateStr], and returns the LAST DAY of the final cycle.
   *
   * Deliberately reuses `BillingService.resolveCurrentPeriod` — the single
   * calendar engine already used by billing, exports and the dashboards —
   * so short-month clamping (a cycle day of 31 in February) behaves exactly
   * as billing does. No second calendar implementation is introduced.
   */
  private cycleEndAfter(
    fromDateStr: string,
    cycleStartDay: number | null,
    cycles: number,
  ): Date {
    let period = this.billing.resolveCurrentPeriod(fromDateStr, cycleStartDay);
    for (let i = 1; i < cycles; i++) {
      const nextStart = new Date(
        toUtcMidnight(period.toDate).getTime() + 24 * 60 * 60 * 1000,
      );
      period = this.billing.resolveCurrentPeriod(fmt(nextStart), cycleStartDay);
    }
    return toUtcMidnight(period.toDate);
  }

  private async processGroup(g: {
    id: string;
    organizationId: string;
    name: string;
    adminId: string | null;
    createdAt: Date;
    mealPricingEnabled: boolean;
    billingCycleStartDay: number | null;
    retentionPurgeThrough: Date | null;
    organization: { timezone: string | null } | null;
  }): Promise<void> {
    // Never below 1 — a misconfigured 0 would purge the cycle still in use.
    const cycles = Math.max(1, this.cfg('cycles', 3));
    const cycleDay = g.billingCycleStartDay ?? null;
    const tz = g.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = todayInTimezone(tz);
    const todayUtc = toUtcMidnight(todayStr);

    // ── Bootstrap the FROZEN, cycle-aligned boundary ────────────────────────
    // The boundary is the last day of the Nth COMPLETE billing cycle counted
    // from the cycle the group was created in. Group.createdAt only picks the
    // STARTING cycle; the boundary itself is always a real cycle end, never
    // "createdAt + 3 months" and never a drifting "now + 3 months".
    const warnDays = Math.max(0, this.cfg('reminderDays', 7));
    const DAY_MS = 24 * 60 * 60 * 1000;

    if (!g.retentionPurgeThrough) {
      let boundary = this.cycleEndAfter(fmt(g.createdAt), cycleDay, cycles);

      // ADOPTION GUARD: a group whose history is ALREADY older than N cycles
      // (created long before this policy, or a delayed deploy) would otherwise
      // be handed a boundary in the PAST — and the very next sweep would purge
      // it with ZERO advance warning. Walk the boundary forward one WHOLE
      // CYCLE at a time until the full warning window fits.
      //
      // This only ever RETAINS MORE data, never less; the boundary stays a
      // real cycle end; and the normal N-cycle rhythm resumes after the first
      // purge. The loop is hard-bounded so a pathological clock/config can
      // never spin.
      const minBoundary = new Date(todayUtc.getTime() + warnDays * DAY_MS);
      for (let guard = 0; boundary < minBoundary && guard < 240; guard++) {
        boundary = this.cycleEndAfter(
          fmt(new Date(boundary.getTime() + DAY_MS)),
          cycleDay,
          1,
        );
      }

      await this.prisma.group.updateMany({
        where: { id: g.id },
        data: { retentionPurgeThrough: boundary },
      });
      return;
    }

    // The frozen cutoff. It NEVER moves because a sweep ran late, retried, or
    // crossed into the next cycle — it is read from the row, not from now().
    const purgeThrough = g.retentionPurgeThrough;

    // ── Phase 1 — warn during the LAST 7 DAYS of the final retained cycle ───
    // The warning lands BEFORE the destructive boundary, so the admin has
    // notice while the data still exists. There is deliberately NO extra
    // post-cycle grace period: the advance warning replaces it.
    const warnStart = new Date(
      purgeThrough.getTime() - Math.max(0, warnDays - 1) * DAY_MS,
    );
    if (todayUtc < warnStart) return; // not due, and not yet worth warning
    if (todayUtc <= purgeThrough) {
      // Still inside the final cycle — warn once per day and touch nothing.
      //
      // ...but only if there is actually something to lose. An empty or
      // brand-new group has no rows at/before the boundary, so warning that
      // "historical data is about to be permanently deleted" would be a plain
      // false alarm — and with several such groups the admin's bell fills with
      // notices about nothing. Cheap indexed count, and only ever inside the
      // short warning window.
      const atRisk = await this.prisma.attendanceRecord.count({
        where: {
          groupId: g.id,
          organizationId: g.organizationId,
          attendanceDate: { lte: purgeThrough },
        },
      });
      if (atRisk === 0) return;
      await this.sendDailyReminder(g, todayStr, fmt(purgeThrough), purgeThrough);
      return;
    }

    // ── The final cycle has CLOSED — destructive phase may be considered ────
    // Everything from here is bounded by the frozen `purgeThrough`; the
    // ACTIVE cycle (which started the day after) can never be touched.
    const cutoffEnd = purgeThrough;

    // Nothing eligible → advance the boundary by another N complete cycles.
    const eligibleRows = await this.prisma.attendanceRecord.count({
      where: {
        groupId: g.id,
        organizationId: g.organizationId,
        attendanceDate: { lte: cutoffEnd },
      },
    });
    if (eligibleRows === 0) {
      // No data to archive, but the boundary still PASSED — a member blocked or
      // removed for the whole window must still age out, otherwise a
      // low-activity group would keep stale memberships forever.
      await this.purgeStaleMemberships(g, cutoffEnd);
      await this.advancePurgeBoundary(g.id, cutoffEnd, cycleDay, cycles);
      return;
    }

    // ── FORCE-CLOSE any still-REOPENED period inside the boundary ──────────
    // The hard N-cycle boundary WINS over a stale reopened state: an admin who
    // forgot to re-close an old period can no longer hold retention hostage.
    //
    // Force-close is NOT force-delete. `refinalizePeriod` rebuilds the period's
    // authoritative `totalsSnapshot` FIRST — so an outstanding balance is
    // captured (and a settled one stays ₹0) — then locks the period and bumps
    // the billing version so carry-forward re-enables. Only after that does the
    // continuity gate below verify the money actually reaches the next cycle.
    //
    // If ANY force-close fails we return WITHOUT purging: a period we could not
    // make financially authoritative must never have its raw data destroyed.
    if (g.mealPricingEnabled) {
      const reopened = await this.prisma.billingPeriod.findMany({
        where: {
          groupId: g.id,
          organizationId: g.organizationId,
          status: 'reopened',
          periodStart: { lte: cutoffEnd },
        },
        select: { id: true, periodStart: true, periodEnd: true },
      });
      for (const period of reopened) {
        try {
          await this.billing.refinalizePeriod(
            g.adminId ?? 'system',
            g.organizationId,
            period.id,
          );
          this.logger.log(
            `Retention force-finalized reopened period group=${g.id} ${fmt(
              period.periodStart,
            )}–${fmt(period.periodEnd)} (retention boundary wins)`,
          );
          this.audit.log({
            organizationId: g.organizationId,
            targetId: period.id,
            targetType: 'BillingPeriod',
            action: AuditAction.update,
            metadata: {
              decision: 'forceFinalized',
              reason: 'retention boundary reached while period was reopened',
              purgeThrough: fmt(cutoffEnd),
            },
          });
        } catch (err) {
          this.logger.error(
            `Retention force-finalize FAILED group=${g.id} period=${period.id}: ${
              (err as Error).message
            } — PURGE BLOCKED`,
          );
          return;
        }
      }
    }

    // Is the bill settled through the cutoff? Computed AFTER the force-close
    // above, so a period we just re-locked counts as finalized here.
    const lastFinalized = g.mealPricingEnabled
      ? await this.prisma.billingPeriod.findFirst({
          where: {
            groupId: g.id,
            organizationId: g.organizationId,
            status: 'finalized',
          },
          orderBy: { periodEnd: 'desc' },
          select: { periodEnd: true },
        })
      : null;
    const needsFinalize =
      g.mealPricingEnabled &&
      (!lastFinalized || lastFinalized.periodEnd < cutoffEnd);

    if (needsFinalize) {
      // Phase 5 step 1/2 — auto-finalize + lock the outstanding span (RET-007).
      const start = lastFinalized
        ? new Date(lastFinalized.periodEnd.getTime() + 24 * 60 * 60 * 1000)
        : await this.earliestDataDate(g.id, g.organizationId, cutoffEnd);
      if (start && start <= cutoffEnd) {
        try {
          await this.billing.finalizePeriod(
            g.adminId ?? 'system',
            g.organizationId,
            {
              groupId: g.id,
              periodStart: fmt(start),
              periodEnd: fmt(cutoffEnd),
            } as any,
          );
          this.logger.log(
            `Retention auto-finalized group=${g.id} ${fmt(start)}–${fmt(cutoffEnd)} (RET-007)`,
          );
        } catch (err) {
          // Overlap/edge — surfaced in logs; retried next sweep.
          this.logger.error(
            `Retention auto-finalize failed group=${g.id}: ${(err as Error).message}`,
          );
          return;
        }
      }
    }

    // ── HARD PRE-DELETION FINANCIAL GATE ───────────────────────────────────
    // Retention must never erase money owed. Before a single raw row is
    // deleted we prove that the closing state of the last retained cycle has
    // been carried into the NEXT cycle's opening state — i.e. that billing no
    // longer depends on the rows we are about to destroy.
    //
    // `computeOpeningBalances` reads the immutable finalize-time
    // `totalsSnapshot` first, so this equality holds BY CONSTRUCTION rather
    // than by luck; the check below proves it for THIS group before deleting.
    // A failure means NO DELETE — log and retry on the next sweep.
    if (g.mealPricingEnabled) {
      const ok = await this.verifyFinancialContinuity(g, cutoffEnd);
      if (!ok) return;
    }

    // Phase 5 steps 4–8 — archive, notify, purge, advance the frozen boundary.
    await this.archiveAndPurge(g, cutoffEnd, cycles, cycleDay);
  }

  /**
   * Proves the next cycle can bill correctly WITHOUT the raw rows that are
   * about to be purged.
   *
   * Closing state = the finalized period's immutable per-member
   * `closingBalance`. Opening state = what `computeOpeningBalances` will hand
   * the next cycle. They must match exactly, member by member.
   *
   * Returns false (BLOCK THE PURGE) on any mismatch, missing snapshot, or
   * error — deletion is only ever allowed on a proven PASS.
   */
  private async verifyFinancialContinuity(
    g: { id: string; organizationId: string; name: string },
    cutoffEnd: Date,
  ): Promise<boolean> {
    try {
      const finalized = await this.prisma.billingPeriod.findFirst({
        where: {
          groupId: g.id,
          organizationId: g.organizationId,
          status: 'finalized',
          periodEnd: { lte: cutoffEnd },
        },
        orderBy: { periodEnd: 'desc' },
        select: { periodEnd: true, totalsSnapshot: true },
      });
      if (!finalized) {
        this.logger.warn(
          `Retention continuity BLOCKED group=${g.id}: no finalized period through ${fmt(cutoffEnd)}`,
        );
        return false;
      }

      const closing = BillingService.openingFromSnapshot(
        finalized.totalsSnapshot,
      );
      if (!closing) {
        this.logger.warn(
          `Retention continuity BLOCKED group=${g.id}: finalized period ${fmt(
            finalized.periodEnd,
          )} has no usable totalsSnapshot — purging would erase carry-forward`,
        );
        return false;
      }

      // What the NEXT cycle will actually open with.
      //
      // NOTE: `computeOpeningBalances` prefers the snapshot, so comparing it to
      // the same snapshot would be tautological. We therefore ALSO force the
      // RAW recomputation (preferSnapshot=false) and compare the snapshot to
      // it. That is the meaningful assertion: it proves the stored snapshot is
      // a faithful record of the raw rows WHILE THEY STILL EXIST — so once
      // they are purged, the snapshot that survives is provably correct.
      const nextStart = new Date(cutoffEnd.getTime() + 24 * 60 * 60 * 1000);
      const policyRow = await this.prisma.group.findFirst({
        where: { id: g.id, organizationId: g.organizationId },
        select: {
          billSkippedMeals: true,
          billAbsentMeals: true,
          guestAttendanceEnabled: true,
          billNoShowGuests: true,
        },
      });
      const opening = await this.billing.computeOpeningBalances(
        g.organizationId,
        g.id,
        nextStart,
        {
          billSkippedMeals: (policyRow as any)?.billSkippedMeals === true,
          billAbsentMeals: (policyRow as any)?.billAbsentMeals ?? null,
          guestAttendanceEnabled: policyRow?.guestAttendanceEnabled === true,
          billNoShowGuests: policyRow?.billNoShowGuests !== false,
        },
      );

      // Independent proof: recompute from the RAW rows about to be deleted.
      const raw = await this.billing.computeOpeningBalances(
        g.organizationId,
        g.id,
        nextStart,
        {
          billSkippedMeals: (policyRow as any)?.billSkippedMeals === true,
          billAbsentMeals: (policyRow as any)?.billAbsentMeals ?? null,
          guestAttendanceEnabled: policyRow?.guestAttendanceEnabled === true,
          billNoShowGuests: policyRow?.billNoShowGuests !== false,
        },
        false, // force the raw path
      );

      // Three-way agreement, member by member:
      //   snapshot closing == what the next cycle opens with == raw truth.
      // Outstanding money can never vanish; settled money can never reappear.
      const mismatches: string[] = [];
      const everyUser = new Set<string>([
        ...closing.keys(),
        ...opening.byUser.keys(),
        ...raw.byUser.keys(),
      ]);
      for (const userId of everyUser) {
        const c = closing.get(userId) ?? 0;
        const o = opening.byUser.get(userId) ?? 0;
        const r = raw.byUser.get(userId) ?? 0;
        if (c !== o || c !== r) mismatches.push(userId);
      }

      if (mismatches.length > 0) {
        this.logger.error(
          `Retention continuity FAILED group=${g.id} through ${fmt(
            cutoffEnd,
          )} — ${mismatches.length} member balance(s) would not carry forward. PURGE BLOCKED.`,
        );
        this.audit.log({
          organizationId: g.organizationId,
          targetId: g.id,
          targetType: 'Group',
          action: AuditAction.update,
          metadata: {
            retentionContinuity: 'FAILED',
            purgeThrough: fmt(cutoffEnd),
            mismatchedMembers: mismatches.length,
            purgeBlocked: true,
          },
        });
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(
        `Retention continuity CHECK ERROR group=${g.id}: ${(err as Error).message} — PURGE BLOCKED`,
      );
      return false;
    }
  }

  /**
   * BR-20/21/22/24/30 — permanent cleanup of stale group memberships.
   *
   * A member Blocked or Removed BEFORE the frozen boundary, and never
   * unblocked/rejoined since, has now been inactive for the entire retention
   * window: their operational history has just aged out through this same
   * lifecycle, so the dangling membership row goes with it. A later join is
   * then a genuinely NEW membership (no row survives to reconnect to).
   *
   * This deliberately rides the GROUP's retention lifecycle — there is no
   * separate per-member timer and therefore no competing clock.
   *
   * BR-24 (the trap): `blockedAt` is NOT cleared when a member is later
   * removed or rejoins, so a member who went blocked -> removed -> rejoined can
   * carry a stale months-old `blockedAt` while being perfectly ACTIVE. STATUS
   * is therefore the gate; the timestamp only measures duration, and is read
   * from the field matching the CURRENT status. An active member can never be
   * selected here no matter what stale timestamp they carry.
   *
   * Legacy rows that predate the audit columns fall back to `updatedAt`, so no
   * membership can become immortal through a NULL.
   */
  private async purgeStaleMemberships(
    g: { id: string; organizationId: string },
    cutoffEnd: Date,
  ): Promise<number> {
    try {
      const candidates = await this.prisma.groupMember.findMany({
        where: {
          groupId: g.id,
          // GroupMember has no org column — isolate through the relation.
          group: { organizationId: g.organizationId },
          status: { in: ['blocked', 'removed'] as any },
        },
        select: {
          id: true,
          userId: true,
          status: true,
          blockedAt: true,
          removedAt: true,
          updatedAt: true,
        },
      });
      if (!candidates.length) return 0;

      const doomed = candidates.filter((m) => {
        const since =
          (m.status as string) === 'blocked' ? m.blockedAt : m.removedAt;
        return (since ?? m.updatedAt).getTime() <= cutoffEnd.getTime();
      });
      if (!doomed.length) return 0;

      await this.prisma.groupMember.deleteMany({
        where: { id: { in: doomed.map((m) => m.id) } },
      });

      this.audit.log({
        organizationId: g.organizationId,
        targetId: g.id,
        targetType: 'Group',
        action: AuditAction.delete,
        metadata: {
          staleMembershipsPurged: doomed.length,
          userIds: doomed.map((m) => m.userId),
          purgeThrough: fmt(cutoffEnd),
          reason:
            'blocked/removed for the whole retention window — membership aged out with its data',
        },
      });
      this.logger.warn(
        `Retention purged ${doomed.length} stale membership(s) group=${g.id} through=${fmt(cutoffEnd)}`,
      );
      return doomed.length;
    } catch (err) {
      // Never let membership housekeeping break the data lifecycle — the
      // financial/archive gates above already passed and their work stands.
      this.logger.error(
        `Stale-membership purge failed group=${g.id}: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  /**
   * Moves the FROZEN boundary forward by exactly [cycles] complete billing
   * cycles, starting from the day after the boundary just handled.
   *
   * Deliberately NOT `now + 3 months`: the next boundary is another real cycle
   * end, so the schedule can never drift away from the billing calendar no
   * matter when the worker actually ran.
   */
  private async advancePurgeBoundary(
    groupId: string,
    handledThrough: Date,
    cycleStartDay: number | null,
    cycles: number,
  ): Promise<void> {
    const nextCycleStart = new Date(
      handledThrough.getTime() + 24 * 60 * 60 * 1000,
    );
    const next = this.cycleEndAfter(fmt(nextCycleStart), cycleStartDay, cycles);
    await this.prisma.group.updateMany({
      where: { id: groupId },
      data: { retentionPurgeThrough: next },
    });
  }

  private async earliestDataDate(
    groupId: string,
    organizationId: string,
    cutoffEnd: Date,
  ): Promise<Date | null> {
    const first = await this.prisma.attendanceRecord.findFirst({
      where: { groupId, organizationId, attendanceDate: { lte: cutoffEnd } },
      orderBy: { attendanceDate: 'asc' },
      select: { attendanceDate: true },
    });
    return first?.attendanceDate ?? null;
  }

  // ── Phase 3 — daily reminders (RET-005/006) ────────────────────────────────

  private async sendDailyReminder(
    g: { id: string; organizationId: string; name: string },
    todayStr: string,
    cutoffStr: string,
    deadline: Date,
  ): Promise<void> {
    const onceKey = `retention:reminder:${g.id}:${todayStr}`;
    if (!(await this.redis.setDedup(onceKey, 36 * 60 * 60))) return;

    const body =
      `Quarterly Data Retention Reminder — ${g.name}: your oldest billing ` +
      `period (through ${cutoffStr}) is now eligible for archival. Please ` +
      `review, finalize, and lock it. If no action is taken by ` +
      `${fmt(deadline)}, the system will automatically finalize the period, ` +
      `generate archive files, and remove historical operational data.`;

    // In-app bell for every group admin (reliable channel).
    try {
      await this.notices.createRequestAlert({
        organizationId: g.organizationId,
        groupId: g.id,
        actorId: 'system',
        title: 'Quarterly Data Retention Reminder',
        body,
        priority: 'high',
      });
    } catch (err) {
      this.logger.warn(
        `Retention reminder bell failed group=${g.id}: ${(err as Error).message}`,
      );
    }
    // Best-effort push to admins with tokens.
    await this.pushToGroupAdmins(g, 'Data Retention Reminder', body);
  }

  private async pushToGroupAdmins(
    g: { id: string; organizationId: string },
    title: string,
    body: string,
  ): Promise<void> {
    try {
      const admins = await this.prisma.user.findMany({
        where: {
          organizationId: g.organizationId,
          fcmToken: { not: null },
          role: {
            in: [
              'messManager',
              'hostelManager',
              'hostelAdmin',
              'organizationManager',
            ] as any,
          },
        },
        select: { id: true, fcmToken: true },
      });
      if (!admins.length) return;
      await this.queue.enqueueBatchPush({
        organizationId: g.organizationId,
        recipients: admins.map((a) => ({
          userId: a.id,
          fcmToken: a.fcmToken!,
        })),
        title,
        body,
        route: '/admin/exports',
        data: { type: 'retention', groupId: g.id },
      });
    } catch (err) {
      this.logger.warn(
        `Retention push failed group=${g.id}: ${(err as Error).message}`,
      );
    }
  }

  // ── Phase 5 — archive generation, notification, purge (RET-008..011) ──────

  private async archiveAndPurge(
    g: {
      id: string;
      organizationId: string;
      name: string;
    },
    cutoffEnd: Date,
    cycles: number,
    cycleStartDay: number | null,
  ): Promise<void> {
    const orgId = g.organizationId;

    // 1. Collect every dataset scheduled for removal (RPT-010 list).
    const [attendance, guests, corrections, vacations, ledger, periods] =
      await Promise.all([
        this.prisma.attendanceRecord.findMany({
          where: { groupId: g.id, organizationId: orgId, attendanceDate: { lte: cutoffEnd } },
          orderBy: [{ attendanceDate: 'asc' }],
          include: {
            user: { select: { name: true, email: true } },
            meal: { select: { name: true, slotKey: true } },
          },
        }),
        this.prisma.mealGuest.findMany({
          where: { groupId: g.id, organizationId: orgId, attendanceDate: { lte: cutoffEnd } },
          orderBy: [{ attendanceDate: 'asc' }],
        }),
        this.prisma.attendanceCorrectionRequest.findMany({
          where: { groupId: g.id, organizationId: orgId, attendanceDate: { lte: cutoffEnd } },
          orderBy: [{ attendanceDate: 'asc' }],
        }),
        (this.prisma as any).vacationRequest.findMany({
          where: { groupId: g.id, organizationId: orgId, endDate: { lte: cutoffEnd } },
          orderBy: [{ startDate: 'asc' }],
        }),
        (this.prisma as any).billingLedgerEntry.findMany({
          where: { groupId: g.id, organizationId: orgId, entryDate: { lte: cutoffEnd } },
          orderBy: [{ entryDate: 'asc' }],
        }),
        this.prisma.billingPeriod.findMany({
          where: { groupId: g.id, organizationId: orgId, periodEnd: { lte: cutoffEnd } },
          orderBy: [{ periodStart: 'asc' }],
        }),
      ]);

    if (attendance.length === 0) {
      await this.advancePurgeBoundary(g.id, cutoffEnd, cycleStartDay, cycles);
      return;
    }
    const periodStart = attendance[0].attendanceDate;

    // ── RET-042 IDEMPOTENCY: reuse an archive already built for this boundary
    // A crash (or PM2 reload, or a MinIO blip on the DELETE side) between
    // "archive stored" and "purge finished" used to make the next sweep build
    // and upload a SECOND archive for the identical boundary. Nothing was lost
    // and no money moved, but it left duplicate GroupArchive rows and burned
    // MinIO storage + CPU regenerating identical files.
    //
    // The archive for a (group, purgeThrough) pair is unique by definition, so
    // an existing row that has NOT yet been stamped `purgedAt` is exactly the
    // artifact this run would have produced. Reuse it and go straight to the
    // purge — making the whole archive->purge sequence safely re-runnable.
    const existingArchive = await (this.prisma as any).groupArchive.findFirst({
      where: {
        organizationId: orgId,
        groupId: g.id,
        periodEnd: cutoffEnd,
        purgedAt: null,
      },
      orderBy: { generatedAt: 'desc' },
    });
    if (existingArchive) {
      this.logger.log(
        `Retention resuming interrupted run group=${g.id} through ${fmt(
          cutoffEnd,
        )} — reusing archive ${existingArchive.id} (RET-042 idempotency)`,
      );
      await this.purgeThroughBoundary(
        g,
        cutoffEnd,
        existingArchive.id,
        cycles,
        cycleStartDay,
        { attendance, corrections },
      );
      return;
    }

    // 2. Build the Excel workbook + PDF summary.
    const counts = {
      attendance: attendance.length,
      guests: guests.length,
      corrections: corrections.length,
      vacations: vacations.length,
      ledgerEntries: ledger.length,
      billingPeriods: periods.length,
    };
    const excel = await this.buildExcel(g.name, periodStart, cutoffEnd, {
      attendance,
      guests,
      corrections,
      vacations,
      ledger,
      periods,
    });
    const pdf = await this.buildPdf(g.name, periodStart, cutoffEnd, counts);

    // 3. Store both in MinIO — RET-009: purge NEVER proceeds unless this
    // succeeded (any throw aborts before a single row is deleted).
    const excelUrl = await this.storage.uploadNoticeAttachment(
      orgId,
      `archive-${g.id}`,
      excel,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx',
    );
    const pdfUrl = pdf
      ? await this.storage.uploadNoticeAttachment(
          orgId,
          `archive-${g.id}`,
          pdf,
          'application/pdf',
          'pdf',
        )
      : null;

    const archive = await (this.prisma as any).groupArchive.create({
      data: {
        organizationId: orgId,
        groupId: g.id,
        groupName: g.name,
        periodStart,
        periodEnd: cutoffEnd,
        excelUrl,
        pdfUrl,
        recordCounts: counts,
      },
    });

    // 4. Notify every admin (RPT-010 step 3 — exact SRS example wording).
    const notifyBody =
      `Historical archive for Group ${g.name} has been generated ` +
      `successfully. Data through ${fmt(cutoffEnd)} has been archived and ` +
      `is available for download from Reports → Data Archives.`;
    try {
      await this.notices.createRequestAlert({
        organizationId: orgId,
        groupId: g.id,
        actorId: 'system',
        title: 'Archive Ready',
        body: notifyBody,
        priority: 'high',
      });
    } catch {
      /* bell is best-effort — the archive row itself is the durable record */
    }
    await this.pushToGroupAdmins(g, 'Archive Ready', notifyBody);

    // 5. Purge — archive verified above, so deletion is safe.
    await this.purgeThroughBoundary(g, cutoffEnd, archive.id, cycles, cycleStartDay, {
      attendance,
      corrections,
    });
  }

  /**
   * The destructive step, extracted so BOTH the fresh path and the RESUMED
   * path (an archive already built by an interrupted run) share exactly one
   * implementation — there is no second deletion code path to drift.
   *
   * Every statement is bounded by the FROZEN [cutoffEnd] and scoped to the
   * group + organization, so it can never touch the active cycle or another
   * tenant. Every delete is a `deleteMany` over a bounded range, which makes
   * re-running it after a crash a no-op rather than an error (RET-042).
   */
  private async purgeThroughBoundary(
    g: { id: string; organizationId: string; name: string },
    cutoffEnd: Date,
    archiveId: string,
    cycles: number,
    cycleStartDay: number | null,
    rows: { attendance: Array<{ id: string }>; corrections: Array<{ id: string }> },
  ): Promise<void> {
    const orgId = g.organizationId;
    const scope = { groupId: g.id, organizationId: orgId };

    // Audit rows tied to the purged records go with them (chunked).
    await this.purgeAuditFor(orgId, rows.attendance.map((r) => r.id));
    await this.purgeAuditFor(orgId, rows.corrections.map((r) => r.id));

    await this.prisma.mealGuest.deleteMany({
      where: { ...scope, attendanceDate: { lte: cutoffEnd } },
    });
    await this.prisma.attendanceCorrectionRequest.deleteMany({
      where: { ...scope, attendanceDate: { lte: cutoffEnd } },
    });
    await (this.prisma as any).vacationRequest.deleteMany({
      where: { ...scope, endDate: { lte: cutoffEnd } },
    });
    await (this.prisma as any).billingLedgerEntry.deleteMany({
      where: { ...scope, entryDate: { lte: cutoffEnd } },
    });
    await this.prisma.notice.deleteMany({
      where: { ...scope, createdAt: { lte: cutoffEnd } },
    });
    await this.prisma.attendanceRecord.deleteMany({
      where: { ...scope, attendanceDate: { lte: cutoffEnd } },
    });
    // BillingPeriod rows are KEPT: they are the immutable finalized-bill
    // record, they hold the authoritative carry-forward snapshot, and they
    // keep the period lock protecting archived dates from becoming editable.

    // Stamping purgedAt CLOSES this run — a later sweep will no longer see an
    // un-purged archive for this boundary, so it cannot resume it twice.
    await (this.prisma as any).groupArchive.updateMany({
      where: { id: archiveId },
      data: { purgedAt: new Date() },
    });

    // BR-21: the members whose history just aged out lose their dangling
    // membership too — same lifecycle, after every safety gate has passed.
    await this.purgeStaleMemberships(g, cutoffEnd);

    // Advance the FROZEN boundary last: if anything above threw, the boundary
    // stays put and the whole run retries cleanly on the next sweep.
    await this.advancePurgeBoundary(g.id, cutoffEnd, cycleStartDay, cycles);
    await this.billing.bumpBillingVersion(g.id);
    this.audit.log({
      organizationId: orgId,
      targetId: archiveId,
      targetType: 'GroupArchive',
      action: AuditAction.create,
      metadata: {
        groupId: g.id,
        periodEnd: fmt(cutoffEnd),
        attendanceRows: rows.attendance.length,
        reason: 'billing-cycle retention archive + production cleanup',
      },
    });
    this.logger.warn(
      `Retention purge complete group=${g.id} through=${fmt(cutoffEnd)} rows=${rows.attendance.length}`,
    );
  }

  private async purgeAuditFor(
    organizationId: string,
    targetIds: string[],
  ): Promise<void> {
    for (let i = 0; i < targetIds.length; i += 1000) {
      const chunk = targetIds.slice(i, i + 1000);
      await this.prisma.auditLog.deleteMany({
        where: { organizationId, targetId: { in: chunk } },
      });
    }
  }

  // ── Report builders ─────────────────────────────────────────────────────────

  private async buildExcel(
    groupName: string,
    from: Date,
    to: Date,
    data: {
      attendance: any[];
      guests: any[];
      corrections: any[];
      vacations: any[];
      ledger: any[];
      periods: any[];
    },
  ): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ExcelJS = require('exceljs');
    const book = new ExcelJS.Workbook();
    book.creator = 'MealAttend';

    const meta = book.addWorksheet('Summary');
    meta.addRows([
      ['MealAttend — Retention Archive'],
      [`Group: ${groupName}`],
      [`Period: ${fmt(from)} to ${fmt(to)}`],
      [`Generated: ${new Date().toISOString()}`],
      [],
      ['Dataset', 'Rows'],
      ['Attendance', data.attendance.length],
      ['Guest bookings', data.guests.length],
      ['Correction requests', data.corrections.length],
      ['Vacation requests', data.vacations.length],
      ['Billing ledger entries', data.ledger.length],
      ['Finalized billing periods', data.periods.length],
    ]);

    const att = book.addWorksheet('Attendance');
    att.addRow([
      'Date', 'Member', 'Email', 'Meal', 'Slot', 'Status', 'Preference',
      'Price', 'Source', 'Marked At',
    ]);
    for (const r of data.attendance) {
      att.addRow([
        fmt(r.attendanceDate), r.user?.name ?? r.userId, r.user?.email ?? '',
        r.meal?.name ?? r.mealId, r.meal?.slotKey ?? '', r.status,
        r.preference ?? '', r.price ?? '', r.source ?? '',
        r.markedAt ? r.markedAt.toISOString() : '',
      ]);
    }

    const gst = book.addWorksheet('Guests');
    gst.addRow(['Date', 'Host', 'Guest', 'Adult', 'Status', 'Price']);
    for (const r of data.guests) {
      gst.addRow([
        fmt(r.attendanceDate), r.hostUserId, r.displayName ?? '',
        r.isAdult ? 'Yes' : 'No', r.status, r.priceSnapshot ?? r.price ?? '',
      ]);
    }

    const cor = book.addWorksheet('Corrections');
    cor.addRow(['Date', 'Member', 'Type', 'Status', 'Requested Status', 'Reviewed By', 'Reviewed At']);
    for (const r of data.corrections) {
      cor.addRow([
        fmt(r.attendanceDate), r.userId, r.requestType, r.status,
        r.requestedStatus ?? '', r.reviewedBy ?? '',
        r.reviewedAt ? r.reviewedAt.toISOString() : '',
      ]);
    }

    const vac = book.addWorksheet('Vacations');
    vac.addRow(['Member', 'Start', 'End', 'Status']);
    for (const r of data.vacations) {
      vac.addRow([r.userName ?? r.userId, fmt(r.startDate), fmt(r.endDate), r.status]);
    }

    const led = book.addWorksheet('Ledger');
    led.addRow(['Date', 'Member', 'Type', 'Amount (paise)', 'Reason']);
    for (const r of data.ledger) {
      led.addRow([fmt(r.entryDate), r.userId, r.type, r.amount, r.reason ?? '']);
    }

    const per = book.addWorksheet('Billing Periods');
    per.addRow(['Start', 'End', 'Status', 'Finalized By', 'Finalized At']);
    for (const r of data.periods) {
      per.addRow([
        fmt(r.periodStart), fmt(r.periodEnd), r.status, r.finalizedBy,
        r.finalizedAt ? r.finalizedAt.toISOString() : '',
      ]);
    }

    return Buffer.from(await book.xlsx.writeBuffer());
  }

  private async buildPdf(
    groupName: string,
    from: Date,
    to: Date,
    counts: Record<string, number>,
  ): Promise<Buffer | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ margin: 48 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      const done = new Promise<Buffer>((resolve) =>
        doc.on('end', () => resolve(Buffer.concat(chunks))),
      );

      doc.fontSize(18).text('MealAttend — Retention Archive Summary');
      doc.moveDown(0.5);
      doc.fontSize(11).text(`Group: ${groupName}`);
      doc.text(`Period: ${fmt(from)} to ${fmt(to)}`);
      doc.text(`Generated: ${new Date().toISOString()}`);
      doc.moveDown();
      doc.fontSize(13).text('Archived datasets');
      doc.moveDown(0.3);
      doc.fontSize(11);
      for (const [k, v] of Object.entries(counts)) {
        doc.text(`•  ${k}: ${v}`);
      }
      doc.moveDown();
      doc
        .fontSize(9)
        .fillColor('#666666')
        .text(
          'The accompanying Excel workbook contains the complete row-level ' +
            'data. These files are the permanent record of the archived ' +
            'period (SRS Module 03 RET-010); the corresponding rows have ' +
            'been removed from the live database to keep it fast and small.',
        );
      doc.end();
      return await done;
    } catch (err) {
      // PDF is the optional summary — Excel alone still satisfies RET-009.
      this.logger.warn(`Archive PDF skipped: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Archive listing (Reports → Data Archives) ───────────────────────────────

  async listArchives(organizationId: string, groupId?: string) {
    const rows = await (this.prisma as any).groupArchive.findMany({
      where: { organizationId, ...(groupId ? { groupId } : {}) },
      orderBy: { generatedAt: 'desc' },
      take: 100,
    });
    return {
      data: rows.map((r: any) => ({
        id: r.id,
        groupId: r.groupId,
        groupName: r.groupName,
        periodStart: fmt(r.periodStart),
        periodEnd: fmt(r.periodEnd),
        excelUrl: r.excelUrl,
        pdfUrl: r.pdfUrl,
        recordCounts: r.recordCounts ?? {},
        generatedAt: r.generatedAt.toISOString(),
        purgedAt: r.purgedAt ? r.purgedAt.toISOString() : null,
      })),
    };
  }
}
