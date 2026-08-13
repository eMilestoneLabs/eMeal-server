/**
 * system-default.worker.ts — Pass 7 (SRS FR-TRUST-001/002/003, Module 33).
 *
 * At window close (close + grace) every active, non-vacation member who has NO
 * record for the meal gets one written with source='system_default':
 *   • attendanceDefault='present' groups → PRESENT (the OPT-OUT trust model:
 *     standing consent under the group's communicated policy);
 *   • every other group → the existing internal System SKIP, so a non-responder
 *     moves out of Pending (Live-Test-14 ISSUE-004). No new status is
 *     introduced, and billing follows the group's existing Skip Billing config:
 *     ON → the row carries its price snapshot and bills by the existing rules,
 *     OFF → price is null, i.e. ₹0 in every money path.
 *
 * Fair-opportunity guarantees (FR-TRUST-003 — fail-safe direction is always
 * "do NOT auto-bill"). These protect the auto-PRESENT claim, which asserts a
 * member ATE, so they gate 'present' only — the System SKIP records the opposite
 * (a non-response) and is written unconditionally:
 *   • the window must have been open ≥ minOptOutMinutes (group override or
 *     ATTENDANCE_MIN_OPT_OUT_MINUTES, default 30)          [present only];
 *   • if no reminder was dispatched for the meal (Redis
 *     reminder:dispatched:* flag from the reminder worker), only members who
 *     have reminders DISABLED are auto-marked — a member who was promised a
 *     reminder that never arrived is neutralized, not billed [present only].
 *
 * Applies to BOTH statuses:
 *   • planner-mode groups: no published entry today = holiday → nothing written
 *     (FR-MODE-032);
 *   • members on vacation or inactive are excluded.
 *
 * Idempotency: createMany(skipDuplicates) against the NON-NEGOTIABLE
 * unique(userId, mealId, attendanceDate) — a member's own mark always wins;
 * re-runs are no-ops. Records are member-correctable via the auto-approving
 * correct_to_absent flow (FR-TRUST-002).
 */

import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../audit/audit.service';
import { QUEUE_NAMES, JOB_TYPES } from '../queue/constants/queue.constants';
import {
  toUtcMidnight,
  getCurrentTimeInTimezone,
  getWindowState,
} from '../common/utils/date.utils';
import { getVacationCoveredUserIds } from '../common/utils/vacation-coverage.util';
import {
  memberFlagWhere,
  resolveMemberFlag,
} from '../common/utils/member-settings.util';
import {
  resolvePublishedDayEntries,
  PublishedDayEntry,
} from '../common/utils/published-day.util';
import { GroupsRepository } from '../features/groups/repositories/groups.repository';
import { RetentionService } from '../features/retention/retention.service';

function todayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function windowMinutes(open: string, close: string): number {
  const [oh, om] = open.split(':').map(Number);
  const [ch, cm] = close.split(':').map(Number);
  const o = oh * 60 + om;
  const c = ch * 60 + cm;
  // Overnight windows wrap past midnight.
  return c >= o ? c - o : 24 * 60 - o + c;
}

@Processor(QUEUE_NAMES.SYSTEM_DEFAULT, { concurrency: 1 })
export class SystemDefaultWorker extends WorkerHost {
  private readonly logger = new Logger(SystemDefaultWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    // Same optional structural pattern as corrections/guests — live dashboards
    // refresh on auto-marks; absent in tests → emits silently skipped.
    @Optional()
    @Inject('ATTENDANCE_GATEWAY')
    private readonly gateway?: {
      emitToGroup(groupId: string, event: string, payload: unknown): void;
    } | null,
    // SRS Module 03 GLC-003: shared hard-delete path for the archive purge.
    // @Optional so existing unit tests construct the worker unchanged.
    @Optional()
    @Inject(GroupsRepository)
    private readonly groupsRepo?: GroupsRepository | null,
    // SRS Module 03 RET-001..015: rolling retention sweep delegate.
    // @Optional so existing unit tests construct the worker unchanged.
    @Optional()
    @Inject(RetentionService)
    private readonly retention?: RetentionService | null,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === JOB_TYPES.SYSTEM_DEFAULT_SWEEP) return this.sweep();
    // Pass 11 (FR-VACX-006): vacation flag lifecycle on the same queue.
    if (job.name === JOB_TYPES.VACATION_SWEEP) return this.vacationSweep();
    // Pass 14 (FR-EVT-054): expired-event cleanup fan-out on the same queue.
    if (job.name === JOB_TYPES.EVENT_CLEANUP_SWEEP) {
      return this.eventCleanupSweep();
    }
    // Pass 15 (FR-NOTX-010): weekly attendance summary digest.
    if (job.name === JOB_TYPES.WEEKLY_DIGEST_SWEEP) {
      return this.weeklyDigestSweep();
    }
    // Pass 15 (FR-NOTX-010): attendance reminder scheduling.
    if (job.name === JOB_TYPES.REMINDER_SCHEDULE_SWEEP) {
      return this.reminderScheduleSweep();
    }
    // SRS Module 03 ATT-010: Personal Auto-Attendance at window OPEN.
    if (job.name === JOB_TYPES.AUTO_ATTENDANCE_SWEEP) {
      return this.autoAttendanceSweep();
    }
    // SRS Module 03 GLC-003: archived-group retention purge.
    if (job.name === JOB_TYPES.GROUP_ARCHIVE_PURGE_SWEEP) {
      return this.groupArchivePurgeSweep();
    }
    // SRS Module 03 RET-001..015: rolling 3-month data-retention lifecycle.
    if (job.name === JOB_TYPES.RETENTION_SWEEP) {
      return this.retention?.sweep();
    }
    // Audit-trail retention fan-out (audit_logs bounded at production scale).
    if (job.name === JOB_TYPES.AUDIT_CLEANUP_SWEEP) {
      return this.auditCleanupSweep();
    }
  }

  // ── Audit-trail retention sweep ────────────────────────────────────────────
  //
  // Fans out one day-deduped CLEANUP_AUDIT_LOGS job per organization (the
  // worker's deleteMany is org-scoped for tenant isolation), then purges
  // org-less rows (organizationId=null, e.g. pre-signup auth events) directly
  // — the per-org job path requires an orgId by design.

  private async auditCleanupSweep(): Promise<void> {
    const olderThanDays = this.config.get<number>('audit.retentionDays', 180);
    if (!olderThanDays || olderThanDays <= 0) return; // retention disabled

    const orgs = await this.prisma.organization.findMany({
      select: { id: true },
    });
    let enqueued = 0;
    for (const { id: organizationId } of orgs) {
      try {
        await this.queue.enqueueAuditLogCleanup({ organizationId, olderThanDays });
        enqueued++;
      } catch (err) {
        // One org failing must not starve the rest — next sweep retries.
        this.logger.error(
          `Audit-cleanup enqueue failed org=${organizationId}: ${(err as Error).message}`,
        );
      }
    }

    let orphanPurged = 0;
    try {
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
      const res = await this.prisma.auditLog.deleteMany({
        where: { organizationId: null, createdAt: { lt: cutoff } },
      });
      orphanPurged = res.count;
    } catch (err) {
      this.logger.error(
        `Audit-cleanup org-less purge failed: ${(err as Error).message}`,
      );
    }

    this.logger.log(
      `Audit-cleanup sweep fanned out to ${enqueued}/${orgs.length} org(s) ` +
      `retention=${olderThanDays}d orphanRowsPurged=${orphanPurged}`,
    );
  }

  // ── SRS Module 03 GLC-003 — archived-group retention purge ────────────────
  //
  // Archive = soft delete (restorable). After the retention period (default
  // 30 days, GROUP_ARCHIVE_RETENTION_DAYS) the archived group is PERMANENTLY
  // deleted automatically — deliberately WITHOUT the GLC-004 operational
  // checks: those apply only to immediate "Delete Now"; a group inactive for
  // a month has nothing live to protect (survey Q7 final decision).
  private async groupArchivePurgeSweep(): Promise<void> {
    if (!this.groupsRepo) return; // not wired (unit-test construction)
    const retentionDays = this.config.get<number>(
      'groups.archiveRetentionDays',
      30,
    );
    if (!retentionDays || retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const expired = await this.prisma.group.findMany({
      where: { isActive: false, archivedAt: { not: null, lte: cutoff } },
      select: { id: true, organizationId: true, name: true, archivedAt: true },
      take: 50, // bounded batch per sweep — the cadence drains any backlog
    });
    if (!expired.length) return;

    for (const g of expired) {
      try {
        // Audit BEFORE the row disappears (same discipline as manual delete).
        this.audit.log({
          organizationId: g.organizationId,
          targetId: g.id,
          targetType: 'Group',
          action: AuditAction.delete,
          metadata: {
            name: g.name,
            permanent: true,
            autoPurge: true,
            archivedAt: g.archivedAt?.toISOString() ?? null,
            retentionDays,
            reason: 'GLC-003 — archive retention period expired',
          },
        });
        await this.groupsRepo.hardDelete(g.id, g.organizationId);
        this.logger.warn(
          `Archived group auto-purged (GLC-003): ${g.name} [${g.id}] org=${g.organizationId}`,
        );
      } catch (err) {
        this.logger.error(
          `Archive purge failed group=${g.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── Pass 15 (FR-NOTX-010) — attendance reminder scheduling sweep ──────────
  //
  // The 30/10-min pre-close reminder producer (NotificationsService.
  // scheduleAttendanceReminders) existed since B6 but had NO production
  // caller — reminders never dispatched, and the opt-out sweep's
  // fair-opportunity check permanently read "no reminder sent". This sweep
  // enqueues today's delayed dispatch jobs directly on the reminder queue.
  //
  // Idempotency is two-layered: queue.scheduleAttendanceReminder uses a
  // deterministic jobId ({org}:{mealId}:{offset}min) so re-adds while the job
  // exists are no-ops, and the dispatch worker's Redis dedup flag (4h TTL)
  // absorbs any straggler double-fire. Holiday days in planner mode get no
  // reminder (FR-MODE-032); AO groups only ever receive these attendance
  // reminders — never meal/menu pushes (FR-MODE-050).
  private async reminderScheduleSweep(): Promise<void> {
    const groups = await this.prisma.group.findMany({
      where: { isActive: true },
      select: {
        id: true,
        organizationId: true,
        mealsEnabled: true,
        weeklyMenuEnabled: true,
        dayWiseMealsEnabled: true,
        organization: { select: { timezone: true } },
      },
    });

    for (const group of groups) {
      try {
        await this.scheduleGroupReminders(group);
      } catch (err) {
        // One bad group never blocks the rest of the sweep.
        this.logger.error(
          `Reminder-schedule sweep failed group=${group.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async scheduleGroupReminders(group: {
    id: string;
    organizationId: string;
    mealsEnabled: boolean;
    weeklyMenuEnabled: boolean;
    dayWiseMealsEnabled: boolean;
    organization: { timezone: string | null } | null;
  }): Promise<void> {
    const tz = group.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = todayInTimezone(tz);
    const nowTime = getCurrentTimeInTimezone(tz);

    // Live-Test-9 ISSUE-003: day entries come from the shared PUBLISHED-day
    // resolver (frozen snapshot, publishedAt-gated, recurring-weekday
    // fallback) — the same source /meals/today renders and marking enforces.
    // The old live-entry read (isPublished:true, exact date only) went blind
    // the moment an admin edit reverted the week to draft AND never saw
    // recurring continuation weeks — reminders silently stopped.
    const [meals, entryMap] = await Promise.all([
      this.prisma.meal.findMany({
        where: {
          groupId: group.id,
          organizationId: group.organizationId,
          attendanceEnabled: true,
        },
        select: {
          id: true,
          slotKey: true,
          isActive: true,
          attendanceWindowClose: true,
        },
      }),
      resolvePublishedDayEntries(this.prisma, {
        groupId: group.id,
        organizationId: group.organizationId,
        dateStr: todayStr,
        // The sweep's group query already selects this, and this runs once PER
        // GROUP — passing it removes a redundant per-group lookup.
        dayWiseMealsEnabled: group.dayWiseMealsEnabled,
      }),
    ]);
    if (!meals.length) return;

    const plannerActive =
      group.mealsEnabled !== false &&
      (group.weeklyMenuEnabled === true || group.dayWiseMealsEnabled === true);

    const [nh, nm] = nowTime.split(':').map(Number);
    const nowMinutes = nh * 60 + nm;

    for (const meal of meals) {
      const entry = entryMap.get(meal.id);
      // Live-Test-9 ISSUE-002: an archived meal is remindable ONLY while the
      // published snapshot still carries it (planner mode); in master mode
      // the archive takes effect immediately.
      if (meal.isActive === false && !plannerActive) continue;
      // FR-MODE-032: holiday / no-meal day in planner mode → no reminder.
      if (plannerActive && !entry) continue;

      const close = entry?.openTime ? entry.closeTime : meal.attendanceWindowClose;
      if (!close || !/^\d{1,2}:\d{2}$/.test(close)) continue;
      const [ch, cm] = close.split(':').map(Number);
      // Already closed today (or an overnight window closing tomorrow) → the
      // next org-day's sweep handles it. Fail-safe direction: never remind
      // for a window that cannot still be marked.
      const minutesUntilClose = ch * 60 + cm - nowMinutes;
      if (minutesUntilClose <= 15) continue;

      const nowMs = Date.now();
      const closeMs = nowMs + minutesUntilClose * 60_000;
      // Same offsets + guards as NotificationsService.scheduleAttendanceReminders
      // (source of truth: student Settings copy — 30 and 10 min before close).
      for (const minutesBefore of [30, 10] as const) {
        if (minutesUntilClose <= minutesBefore + 5) continue;
        await this.queue.scheduleAttendanceReminder(
          {
            organizationId: group.organizationId,
            groupId: group.id,
            mealId: meal.id,
            mealSlotKey: meal.slotKey,
            windowCloseAt: new Date(closeMs).toISOString(),
            minutesBefore,
          },
          closeMs - nowMs - minutesBefore * 60_000,
        );
      }
    }
  }

  // ── Pass 15 (FR-NOTX-010) — weekly attendance summary digest ──────────────
  //
  // Fires once per group per digest day (org timezone): when org-local time
  // reaches digestHour on digestDay, members receive a push summarising the
  // group's last 7 days. Consent: only members with remindersEnabled=true and
  // a registered device get it (LOOP-083 — remindersEnabled IS the digest
  // opt-out); the once-flag caps it at one push/week (anti-spam). Content is
  // aggregate counts only — no names, no amounts (FR-NOTX-017).
  private async weeklyDigestSweep(): Promise<void> {
    const digestDay = this.config.get<number>('attendance.weeklyDigestDay', 1);
    const digestHour = this.config.get<number>('attendance.weeklyDigestHour', 8);

    const groups = await this.prisma.group.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        organizationId: true,
        organization: { select: { timezone: true } },
      },
    });

    let dispatched = 0;
    for (const group of groups) {
      try {
        const tz = group.organization?.timezone ?? 'Asia/Kolkata';
        const todayStr = todayInTimezone(tz);
        const todayUtc = toUtcMidnight(todayStr);
        // Org-local weekday + hour gate. Late sweeps still fire (hour >=),
        // the once-flag keeps it to a single dispatch per digest day.
        if (todayUtc.getUTCDay() !== digestDay) continue;
        const hourNow = parseInt(getCurrentTimeInTimezone(tz).slice(0, 2), 10);
        if (hourNow < digestHour) continue;

        const onceKey = `digest:done:${group.id}:${todayStr}`;
        if (!(await this.redis.setDedup(onceKey, 48 * 60 * 60))) continue;

        await this.dispatchGroupDigest(group, todayUtc);
        dispatched++;
      } catch (err) {
        // One bad group never blocks the rest of the sweep.
        this.logger.error(
          `Weekly digest failed group=${group.id}: ${(err as Error).message}`,
        );
      }
    }
    if (dispatched > 0) {
      this.logger.log(`Weekly digest dispatched for ${dispatched} group(s)`);
    }
  }

  private async dispatchGroupDigest(
    group: { id: string; name: string; organizationId: string },
    todayUtc: Date,
  ): Promise<void> {
    const weekAgo = new Date(todayUtc.getTime() - 7 * 86_400_000);

    const [statusRows, recipientsRaw] = await Promise.all([
      this.prisma.attendanceRecord.groupBy({
        by: ['status'],
        where: {
          organizationId: group.organizationId,
          groupId: group.id,
          attendanceDate: { gte: weekAgo, lt: todayUtc },
        },
        _count: { _all: true },
      }),
      this.prisma.groupMember.findMany({
        where: {
          groupId: group.id,
          status: 'active',
          user: { remindersEnabled: true, fcmToken: { not: null } },
        },
        select: { userId: true, user: { select: { fcmToken: true } } },
      }),
    ]);

    const recipients = recipientsRaw
      .filter((m) => m.user.fcmToken)
      .map((m) => ({ userId: m.userId, fcmToken: m.user.fcmToken! }));
    if (!recipients.length) return;

    const counts: Record<string, number> = {};
    for (const row of statusRows) counts[row.status] = row._count._all;
    const present = counts['present'] ?? 0;
    const absent = counts['absent'] ?? 0;
    const skipped = counts['skipped'] ?? 0;
    const denom = present + absent + skipped;
    // Nothing happened last week → nothing to digest (quiet by default).
    if (denom === 0) return;
    const rate = Math.round((present / denom) * 100);

    await this.queue.enqueueBatchPush({
      organizationId: group.organizationId,
      recipients,
      title: 'Weekly Attendance Summary',
      body:
        `${group.name} — last 7 days: ${present} present, ${absent} absent, ` +
        `${skipped} skipped (${rate}% attendance). Open the app for details.`,
      route: '/student/attendance',
      data: { type: 'weekly_digest', groupId: group.id },
    });

    this.logger.log(
      `Weekly digest: group=${group.id} recipients=${recipients.length} rate=${rate}%`,
    );
  }

  // ── Pass 14 (FR-EVT-054/FR-EVTX-023) — expired-event cleanup fan-out ──────
  //
  // Enqueues the existing per-org CLEANUP_EXPIRED_EVENTS job for every org
  // that has auto-delete events. cutoffDate is the UTC DATE (not instant) so
  // the jobId dedupes to one cleanup per org per day regardless of sweep
  // cadence; the cleanup itself is idempotent either way (LOOP-073).
  private async eventCleanupSweep(): Promise<void> {
    const orgs = await this.prisma.event.findMany({
      where: { autoDeleteAfter7Days: true },
      select: { organizationId: true },
      distinct: ['organizationId'],
    });
    if (orgs.length === 0) return;

    const cutoffDate = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const { organizationId } of orgs) {
      try {
        await this.queue.enqueueExpiredEventCleanup({
          organizationId,
          cutoffDate,
        });
        enqueued++;
      } catch (err) {
        // One org failing must not starve the rest — next sweep retries.
        this.logger.error(
          `Event-cleanup enqueue failed org=${organizationId}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Event-cleanup sweep fanned out to ${enqueued}/${orgs.length} org(s) cutoff=${cutoffDate}`,
    );
  }

  // ── Pass 11 (FR-VACX-006) — vacation flag lifecycle sweep ─────────────────
  //
  // Approved dated vacations drive isVacationMode deterministically even for
  // users who never open the app (read-time sync covers the ones who do):
  //   • activate: an approved request covers today (org timezone) → flag ON;
  //   • resume:   flag ON, user HAS approved requests, none covers today →
  //               flag OFF (the day after endDate, TZ-correct — ISSUE-5).
  // Pure-toggle users (no approved requests) are never touched (FR-VACX-001).

  private async vacationSweep(): Promise<void> {
    const now = new Date();
    // Candidate window: any request whose range could cover "today" in ANY
    // timezone (±1 day of UTC now) — tiny, indexed.
    const lo = new Date(now.getTime() - 2 * 86_400_000);
    const hi = new Date(now.getTime() + 2 * 86_400_000);

    const [flaggedUsers, flaggedMembers, activeRequests] = await Promise.all([
      this.prisma.user.findMany({
        where: { isVacationMode: true },
        select: { id: true, organizationId: true },
      }),
      // The MEMBERSHIP counterpart of `flaggedUsers`, and it earns its place
      // the same way: it is the in-memory guard that stops the sweep writing
      // when nothing changed. Without it every group holding a live
      // group-scoped vacation issued a no-op `updateMany` on EVERY tick —
      // N wasted statements per tick, growing with group count. One read in
      // the wave that already runs replaces all of them, so this adds no
      // round trip and strictly reduces work.
      this.prisma.groupMember.findMany({
        where: { isVacationMode: true },
        select: { userId: true, groupId: true },
      }),
      (this.prisma as any).vacationRequest.findMany({
        where: {
          status: 'approved',
          deletedAt: null,
          startDate: { lte: hi },
          endDate: { gte: lo },
        },
        select: {
          userId: true,
          organizationId: true,
          startDate: true,
          endDate: true,
          // A-full: WHICH group this leave is for. One free column on a select
          // this sweep already makes. `null` = org-level (governs every group).
          groupId: true,
        },
      }) as Promise<
        Array<{
          userId: string;
          organizationId: string;
          startDate: Date;
          endDate: Date;
          groupId: string | null;
        }>
      >,
    ]);
    if (!flaggedUsers.length && !activeRequests.length) return;

    // Per-org "today" (UTC-midnight representation of the org business day).
    const orgIds = new Set<string>();
    for (const u of flaggedUsers) if (u.organizationId) orgIds.add(u.organizationId);
    for (const r of activeRequests) orgIds.add(r.organizationId);
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: [...orgIds] } },
      select: { id: true, timezone: true },
    });
    const todayByOrg = new Map<string, number>();
    for (const o of orgs) {
      todayByOrg.set(
        o.id,
        toUtcMidnight(todayInTimezone(o.timezone ?? 'Asia/Kolkata')).getTime(),
      );
    }

    const coversToday = (r: { organizationId: string; startDate: Date; endDate: Date }) => {
      const today = todayByOrg.get(r.organizationId);
      return (
        today !== undefined &&
        r.startDate.getTime() <= today &&
        r.endDate.getTime() >= today
      );
    };

    // Activations: covered today but flag OFF.
    //
    // A-full: an ORG-LEVEL request (groupId null) governs every group, so the
    // ACCOUNT flag stays its home — unchanged. A GROUP-SCOPED request has no
    // room in that single bit; writing it there marked the member on vacation
    // in every group they belong to, so it targets ITS membership row instead.
    const flaggedSet = new Set(flaggedUsers.map((u) => u.id));
    const flaggedMemberSet = new Set(
      flaggedMembers.map((m) => `${m.userId}:${m.groupId}`),
    );
    const toActivate = new Map<string, string>(); // userId → orgId (ORG-LEVEL only)
    // groupId → (userId → orgId). The orgId rides along so the group-scoped
    // changes are AUDITED exactly like the account-flag ones (FR-VACX-006
    // observability): a vacation state change must never be silent.
    const memberActivate = new Map<string, Map<string, string>>();
    for (const r of activeRequests) {
      if (!coversToday(r)) continue;
      if (r.groupId == null) {
        if (!flaggedSet.has(r.userId)) toActivate.set(r.userId, r.organizationId);
      } else if (!flaggedMemberSet.has(`${r.userId}:${r.groupId}`)) {
        // Already active — skip, exactly as `flaggedSet` does for the account
        // flag. The `not: true` predicate on the write is still the safety
        // net; this is the cost guard.
        const m = memberActivate.get(r.groupId) ?? new Map<string, string>();
        m.set(r.userId, r.organizationId);
        memberActivate.set(r.groupId, m);
      }
    }

    // Resumes: flag ON, an approved request JUST ENDED (inside the ±2-day
    // candidate window), none covering today. Live-Test-8 ISSUE-007: the old
    // rule ("has ANY approved request ever", resolved with an extra batched
    // query) force-cleared MANUAL toggle vacations for members with
    // historical requests — exposing them to auto-Present billing
    // mid-vacation. A recently-ended request is the only legitimate
    // auto-resume trigger (identical rule to the read-time sync); the extra
    // query is gone with it.
    // Both sets gate the ACCOUNT flag, so both consider ORG-LEVEL requests
    // ONLY. A group-scoped request owns its own membership row (handled by
    // memberActivate / memberResume below) and must never hold the account
    // flag open: an expired ORG-LEVEL vacation would then stay switched on
    // just because an unrelated group's vacation started — re-creating, via
    // the resume path, the exact cross-group spill A-full removed.
    const orgLevelRequests = activeRequests.filter((r) => r.groupId == null);
    const coveredNow = new Set(
      orgLevelRequests.filter(coversToday).map((r) => r.userId),
    );
    const recentlyEnded = new Set(
      orgLevelRequests
        .filter((r) => {
          const today = todayByOrg.get(r.organizationId);
          return today !== undefined && r.endDate.getTime() < today;
        })
        .map((r) => r.userId),
    );
    const toResume = flaggedUsers.filter(
      (u) =>
        u.organizationId &&
        !coveredNow.has(u.id) &&
        !toActivate.has(u.id) &&
        recentlyEnded.has(u.id),
    ) as Array<{ id: string; organizationId: string }>;

    // A-full group-scoped resume: a membership activated by a GROUP-SCOPED
    // request whose range has now ended goes back to NULL (inherit) — never
    // `false`, which would be an explicit override permanently shadowing any
    // later org-wide vacation for that group.
    //
    // Same LT-8 ISSUE-007 guard as the account flag, applied per group: only a
    // request FOR THAT GROUP that recently ended may resume it. Membership
    // pairs still covered today are excluded so an overlapping range cannot
    // resume a live vacation.
    const coveredPairs = new Set(
      activeRequests
        .filter((r) => coversToday(r) && r.groupId != null)
        .map((r) => `${r.userId}:${r.groupId}`),
    );
    const memberResume = new Map<string, Map<string, string>>(); // groupId → (userId → orgId)
    for (const r of activeRequests) {
      if (r.groupId == null) continue;
      const today = todayByOrg.get(r.organizationId);
      if (today === undefined || r.endDate.getTime() >= today) continue;
      if (coveredPairs.has(`${r.userId}:${r.groupId}`)) continue;
      // Only a membership that is actually ON can be resumed — same guard, so
      // an ended request for a group that was never activated writes nothing.
      if (!flaggedMemberSet.has(`${r.userId}:${r.groupId}`)) continue;
      const m = memberResume.get(r.groupId) ?? new Map<string, string>();
      m.set(r.userId, r.organizationId);
      memberResume.set(r.groupId, m);
    }

    // Both member writes are guarded by the CURRENT value in the WHERE clause,
    // which is what makes them safe and free:
    //   • activate matches `isVacationMode: { not: true }` — idempotent for
    //     rows already active, while still letting a NEW approved request
    //     re-activate a group the member once returned early from (the
    //     account-flag path has always recovered that way). Return Early is
    //     protected by its request being ENDED, not by the column value;
    //   • resume matches `isVacationMode: true` — only rows a request actually
    //     activated.
    // No read of current state is needed, so the sweep adds ZERO queries.
    // TENANT ISOLATION: each (groupId, userIds) pair is built from ONE
    // request row, so the group and its members always belong to the same
    // organization — a request's groupId is validated against the member's own
    // membership at creation. The sweep is deliberately global (it serves every
    // org), and no predicate here can address a row outside the pair's own org.
    // ONE parallel wave, never a sequential await per group (guidebook §7:
    // zero awaits-in-loops). Grouping by groupId keeps each statement on the
    // (groupId, userId) index; firing them together keeps the sweep at a
    // single round trip regardless of how many groups activate on a day.
    await Promise.all([
      ...[...memberActivate].map(([groupId, byUser]) =>
        this.prisma.groupMember.updateMany({
          where: {
            groupId,
            userId: { in: [...byUser.keys()] },
            isVacationMode: { not: true },
          },
          data: { isVacationMode: true },
        }),
      ),
      ...[...memberResume].map(([groupId, byUser]) =>
        this.prisma.groupMember.updateMany({
          where: {
            groupId,
            userId: { in: [...byUser.keys()] },
            isVacationMode: true,
          },
          data: { isVacationMode: null },
        }),
      ),
    ]);

    if (toActivate.size) {
      await this.prisma.user.updateMany({
        where: { id: { in: [...toActivate.keys()] } },
        data: { isVacationMode: true },
      });
    }
    if (toResume.length) {
      await this.prisma.user.updateMany({
        where: { id: { in: toResume.map((u) => u.id) } },
        data: { isVacationMode: false },
      });
    }

    for (const [userId, orgId] of toActivate) {
      this.audit.log({
        organizationId: orgId,
        targetId: userId,
        targetType: 'User',
        action: AuditAction.update,
        metadata: { isVacationMode: true, reason: 'vacation sweep — approved range started (FR-VACX-006)' },
      });
    }
    for (const u of toResume) {
      this.audit.log({
        organizationId: u.organizationId,
        targetId: u.id,
        targetType: 'User',
        action: AuditAction.update,
        metadata: { isVacationMode: false, reason: 'vacation sweep — approved range ended (FR-VACX-006)' },
      });
    }
    // Audit parity for the GROUP-SCOPED changes — same shape as the
    // account-flag entries above, plus the group the leave belongs to.
    for (const [groupId, byUser] of memberActivate) {
      for (const [userId, orgId] of byUser) {
        this.audit.log({
          organizationId: orgId,
          targetId: userId,
          targetType: 'User',
          action: AuditAction.update,
          metadata: { isVacationMode: true, groupId, reason: 'vacation sweep — approved group-scoped range started (FR-VACX-006)' },
        });
      }
    }
    for (const [groupId, byUser] of memberResume) {
      for (const [userId, orgId] of byUser) {
        this.audit.log({
          organizationId: orgId,
          targetId: userId,
          targetType: 'User',
          action: AuditAction.update,
          metadata: { isVacationMode: false, groupId, reason: 'vacation sweep — approved group-scoped range ended (FR-VACX-006)' },
        });
      }
    }
    const memberChanges =
      [...memberActivate.values()].reduce((n, m) => n + m.size, 0) +
      [...memberResume.values()].reduce((n, m) => n + m.size, 0);
    if (toActivate.size || toResume.length || memberChanges) {
      this.logger.log(
        `Vacation sweep: activated=${toActivate.size} resumed=${toResume.length} groupScoped=${memberChanges}`,
      );
    }
  }

  // ── SRS Module 03 ATT-010 — Personal Auto-Attendance (window OPEN) ────────
  //
  // Members who enable Personal Auto-Attendance are marked Present the moment
  // an eligible meal's attendance window OPENS (not at close), so kitchen
  // dashboards and billing see real-time expected counts. Eligibility per
  // ATT-010: toggle ON · active member · not on approved vacation · the meal
  // does NOT require preference selection (ATT-011 suspends auto-attendance
  // for preference meals — those stay manual and become Skipped at close per
  // the group policy) · window open · no record yet. Each (meal, date) pair
  // materializes exactly once (Redis dedup); a member enabling the toggle
  // mid-window starts from the NEXT window ("window has just opened").
  private async autoAttendanceSweep(): Promise<void> {
    // Only groups that actually have opted-in active members. Auto-attendance
    // is a PER-GROUP setting, so opting in for one group must not enrol the
    // member's other groups — the effective value decides, per membership.
    const optedIn = await this.prisma.groupMember.findMany({
      where: {
        status: 'active',
        ...memberFlagWhere('isDefaultAttendance', true),
      },
      select: { groupId: true },
      distinct: ['groupId'],
    });
    if (!optedIn.length) return;

    const groups = await this.prisma.group.findMany({
      where: { id: { in: optedIn.map((g) => g.groupId) }, isActive: true },
      select: {
        id: true,
        organizationId: true,
        attendanceGraceMinutes: true,
        mealsEnabled: true,
        weeklyMenuEnabled: true,
        dayWiseMealsEnabled: true,
        organization: { select: { timezone: true } },
      },
    });

    for (const group of groups) {
      try {
        await this.autoAttendanceSweepGroup(group);
      } catch (err) {
        this.logger.error(
          `Auto-attendance sweep failed group=${group.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async autoAttendanceSweepGroup(group: {
    id: string;
    organizationId: string;
    attendanceGraceMinutes: number | null;
    mealsEnabled: boolean;
    weeklyMenuEnabled: boolean;
    dayWiseMealsEnabled: boolean;
    organization: { timezone: string | null } | null;
  }): Promise<void> {
    // Live-Test-11 ISSUE-002 (user-confirmed rule, supersedes the Live-Test-8
    // blanket gate): Attendance-Only Mode ≠ Meal System. When mealsEnabled is
    // OFF only MEAL functionality is inert — the group's attendance WINDOWS
    // remain the primary attendance mechanism, so personal Auto-Attendance
    // still materializes on them. Guarantees in attendance-only mode:
    //  • price is ALWAYS null (no meal billing can ever be generated),
    //  • the planner overlay is ignored (windows come from the MASTER rows —
    //    the exact set /meals/today shows and marking enforces),
    //  • preference gates below still apply to any leftover meal-era rows.
    const attendanceOnly = group.mealsEnabled === false;
    const tz = group.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = todayInTimezone(tz);
    const nowTime = getCurrentTimeInTimezone(tz);
    const dateUtc = toUtcMidnight(todayStr);
    const grace = Math.max(0, group.attendanceGraceMinutes ?? 0);

    // Live-Test-9 ISSUE-003: day entries via the shared PUBLISHED-day resolver
    // (frozen snapshot, publishedAt-gated, recurring-weekday fallback) — the
    // exact set /meals/today renders. The old live-entry read (isPublished:
    // true, exact date only) skipped every meal while an admin edit held the
    // week in draft AND on recurring continuation weeks — auto-attendance
    // "not firing at all". The meal list now includes archived meals: an
    // archived-but-still-published meal keeps auto-marking until republish
    // (ISSUE-002), gated below.
    const [meals, entryMap] = await Promise.all([
      this.prisma.meal.findMany({
        where: {
          groupId: group.id,
          organizationId: group.organizationId,
          attendanceEnabled: true,
        },
        select: {
          id: true,
          name: true,
          slotKey: true,
          isActive: true,
          preferencesEnabled: true,
          attendanceWindowOpen: true,
          attendanceWindowClose: true,
          price: true,
        },
      }),
      // ISSUE-002: attendance-only ignores the planner entirely (meal-system
      // machinery) — skip the published-day query, no entries to overlay.
      attendanceOnly
        ? Promise.resolve(new Map<string, PublishedDayEntry>())
        : resolvePublishedDayEntries(this.prisma, {
            groupId: group.id,
            organizationId: group.organizationId,
            dateStr: todayStr,
          }),
    ]);
    if (!meals.length) return;

    // ATT-011/013: preference-group meals are excluded from auto-attendance.
    // Live-Test-8 ISSUE-001: suspended bindings (meal in Standalone mode)
    // don't require picks — only ACTIVE bindings gate the exclusion.
    const boundGroups = await this.prisma.mealPreferenceGroup.findMany({
      where: { mealId: { in: meals.map((m) => m.id) }, isActive: true } as any,
      select: { mealId: true },
      distinct: ['mealId'],
    });
    const hasGroups = new Set(boundGroups.map((b) => b.mealId));

    // ISSUE-002: attendance-only never runs planner mode (same rule as the
    // /meals/today overlay and the marking path's plannerActive gate).
    const plannerActive =
      !attendanceOnly &&
      (group.weeklyMenuEnabled === true || group.dayWiseMealsEnabled === true);

    for (const meal of meals) {
      const entry = entryMap.get(meal.id);
      // Live-Test-9 ISSUE-002: archived meals stay eligible ONLY while the
      // published snapshot carries them (planner mode); master-mode archives
      // take effect immediately.
      if (meal.isActive === false && !plannerActive) continue;
      // FR-MODE-032: holiday / no-meal day in planner mode → nothing to mark.
      if (plannerActive && !entry) continue;
      // ATT-011: preference-required meals stay manual — auto-attendance
      // NEVER guesses a member's picks. Live-Test-8 ISSUE-006: the
      // requirement is DAY-EFFECTIVE (published schedule = single source of
      // truth): a day entry that disables preferences clears both the flat
      // tags AND the meal's bound groups for that day (the exact
      // applyDayOverride rule /meals/today renders and marking validates),
      // so such days auto-mark normally. Master flags gate only when the day
      // entry doesn't override them.
      // P-01: see the identical rule in the materialize sweep below — a
      // fully frozen published day decides from its FROZEN preference block.
      const dayFlatPrefs = entry?.configurationFrozen
        ? entry.preference?.enabled === true &&
          entry.preference?.mode === 'standalone'
        : (entry?.preferencesEnabled ?? meal.preferencesEnabled);
      const dayGroupPrefs = entry?.configurationFrozen
        ? entry.preference?.enabled === true &&
          entry.preference?.mode === 'group'
        : hasGroups.has(meal.id) && entry?.preferencesEnabled !== false;
      if (dayFlatPrefs === true || dayGroupPrefs) {
        continue;
      }

      const open = entry?.openTime ? entry.openTime : meal.attendanceWindowOpen;
      const close = entry?.openTime
        ? entry.closeTime
        : meal.attendanceWindowClose;
      if (!open || !close) continue;

      // ATT-010: materialize while the window is OPEN (grace still counts as
      // markable, so a sweep tick landing in grace still marks correctly).
      const state = getWindowState(nowTime, open, close, grace);
      if (state !== 'open' && state !== 'grace') continue;

      await this.materializeAutoAttendance({
        group,
        mealId: meal.id,
        mealName: meal.name,
        slotKey: (meal as any).slotKey ?? null,
        dateUtc,
        dateStr: todayStr,
        // ISSUE-002: attendance-only windows NEVER bill — meal billing is
        // meal-system functionality and the meal system is OFF.
        price: attendanceOnly
          ? null
          : entry?.price != null
            ? entry.price
            : (meal.price ?? null),
        openTime: open,
      });
    }
  }

  private async materializeAutoAttendance(params: {
    group: { id: string; organizationId: string };
    mealId: string;
    mealName: string;
    /** ISSUE-005: boundary-identity vacation coverage (start/end meal). */
    slotKey?: string | null;
    dateUtc: Date;
    dateStr: string;
    price: number | null;
    openTime: string | null;
  }): Promise<void> {
    const { group, mealId, dateUtc, dateStr, price } = params;

    // Once per (meal, date): members who later unmark/change are never
    // re-defaulted — their explicit action always wins (FR-TRUST-002).
    const onceKey = `autoattend:done:${group.organizationId}:${mealId}:${dateStr}`;
    if (!(await this.redis.setDedup(onceKey, 48 * 60 * 60))) return;

    const [members, existing] = await Promise.all([
      this.prisma.groupMember.findMany({
        where: {
          groupId: group.id,
          status: 'active',
          ...memberFlagWhere('isDefaultAttendance', true),
        },
        select: {
          userId: true,
          // Per-group override rides the SAME row; the user flag stays as the
          // inherited fallback. No extra query, one boolean more on the wire.
          isVacationMode: true,
          user: { select: { isVacationMode: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { mealId, attendanceDate: dateUtc },
        select: { userId: true },
      }),
    ]);
    if (!members.length) return;

    // ATT-010 eligibility: never auto-mark a member on approved vacation.
    const onVacation = await getVacationCoveredUserIds(this.prisma as any, {
      organizationId: group.organizationId,
      groupId: group.id,
      dateUtc,
      mealOpenTime: params.openTime,
      mealSlotKey: params.slotKey ?? null,
      candidates: members.map((m) => ({
        userId: m.userId,
        isVacationMode: resolveMemberFlag(m, m.user, 'isVacationMode'),
      })),
    });

    const already = new Set(existing.map((r) => r.userId));
    const eligible = members.filter(
      (m) => !already.has(m.userId) && !onVacation.has(m.userId),
    );
    if (!eligible.length) return;

    await this.prisma.attendanceRecord.createMany({
      data: eligible.map((m) => ({
        organizationId: group.organizationId,
        groupId: group.id,
        userId: m.userId,
        mealId,
        attendanceDate: dateUtc,
        status: 'present' as const,
        markedAt: new Date(),
        markedBy: null,
        price,
        source: 'system_default',
      })),
      skipDuplicates: true, // races with self-marks: the member always wins
    });

    const created = await this.prisma.attendanceRecord.findMany({
      where: {
        mealId,
        attendanceDate: dateUtc,
        source: 'system_default',
        userId: { in: eligible.map((m) => m.userId) },
      },
      select: { id: true, userId: true },
    });
    for (const rec of created) {
      this.audit.log({
        organizationId: group.organizationId,
        targetId: rec.id,
        targetType: 'Attendance',
        action: AuditAction.create,
        metadata: {
          source: 'system_default',
          status: 'present',
          reason:
            'Personal Auto-Attendance — marked Present at window open (ATT-010)',
        },
      });
    }

    // Cache parity + billing version bump + live kitchen count — identical
    // discipline to the close-time sweep so dashboards update in real time.
    const cacheKeys = [
      `attendance:group:${group.organizationId}:${group.id}:${dateStr}`,
      `attendance:meal:${group.organizationId}:${mealId}:${dateStr}`,
      `dashboard:admin:${group.organizationId}`,
      ...created.flatMap((r) => [
        `attendance:summary:${group.organizationId}:${r.userId}:${group.id}`,
        `dashboard:student:${group.organizationId}:${r.userId}`,
      ]),
    ];
    try {
      await this.redis.del(...cacheKeys);
    } catch (_) {
      /* best-effort */
    }
    try {
      await this.redis.set(`bill:ver:${group.id}`, Date.now().toString());
    } catch (_) {
      /* best-effort */
    }
    try {
      this.gateway?.emitToGroup(group.id, 'attendance.updated.v1', {
        groupId: group.id,
        mealId,
        date: dateStr,
        source: 'system_default',
        count: created.length,
      });
    } catch (_) {
      /* best-effort */
    }

    this.logger.log(
      `Auto-attendance sweep: group=${group.id} meal=${mealId} date=${dateStr} created=${created.length}`,
    );
  }

  private async sweep(): Promise<void> {
    // At window close, a member who never responded gets a record:
    //   • opt-out groups (attendanceDefault='present') → PRESENT
    //     (FR-TRUST-001/002/003, unchanged);
    //   • every other group → the EXISTING internal System SKIP.
    //
    // Live-Test-14 ISSUE-004: the group filter used to be
    // `attendanceDefault='present' OR billSkippedMeals`, so an ordinary group was
    // never swept — its non-responders stayed record-less and `pendingCount`
    // (expected − present − absent − skipped) never reached zero. Every active
    // group is swept now. This adds NO status and NO business rule: it only
    // assigns the existing System SKIP so members move Pending → Skip.
    //
    // Billing follows the group's EXISTING Skip Billing configuration and
    // nothing else — ON: the Skip carries its scheduled price snapshot and bills
    // by the existing rules; OFF: price is null, which is ₹0 in every money path
    // (`price ?? 0` in the summary engine and exports, `_sum: { price: true }`
    // behind BillingService.billedAttendanceFilter()), so no billing is
    // generated. Because the decision is snapshotted per row, later ON/OFF flips
    // never touch prior bills (Live-Test-8 ISSUE-005 date-forward discipline).
    // Opt-out (auto-Present) still wins when both policies are on.
    const groups = await this.prisma.group.findMany({
      where: { isActive: true },
      select: {
        id: true,
        organizationId: true,
        attendanceDefault: true,
        billSkippedMeals: true,
        attendanceGraceMinutes: true,
        minOptOutMinutes: true,
        mealsEnabled: true,
        weeklyMenuEnabled: true,
        dayWiseMealsEnabled: true,
        organization: { select: { timezone: true } },
      },
    });
    if (!groups.length) return;

    const defaultFloor = this.config.get<number>(
      'attendance.minOptOutMinutes',
      30,
    );

    for (const group of groups) {
      try {
        await this.sweepGroup(group, defaultFloor);
      } catch (err) {
        // One bad group never blocks the rest of the sweep.
        this.logger.error(
          `System-default sweep failed group=${group.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async sweepGroup(
    group: {
      id: string;
      organizationId: string;
      attendanceDefault?: string | null;
      billSkippedMeals?: boolean;
      attendanceGraceMinutes: number | null;
      minOptOutMinutes: number | null;
      mealsEnabled: boolean;
      weeklyMenuEnabled: boolean;
      dayWiseMealsEnabled: boolean;
      organization: { timezone: string | null } | null;
    },
    defaultFloor: number,
  ): Promise<void> {
    // Live-Test-11 ISSUE-002 (user-confirmed rule, supersedes the Live-Test-8
    // blanket gate): attendance WINDOWS stay fully functional when the meal
    // system is OFF — the close-time sweep still materializes Present/Skip on
    // them (attendance automation), but price is ALWAYS null (no meal billing
    // can ever be generated) and the planner overlay is ignored (windows come
    // from the MASTER rows, the exact set /meals/today shows).
    const attendanceOnly = group.mealsEnabled === false;
    // Opt-out (auto-Present) wins when both policies are enabled — a group
    // where everyone defaults to Present has no unmarked members to Skip.
    const materializeStatus: 'present' | 'skipped' =
      group.attendanceDefault === 'present' ? 'present' : 'skipped';
    const tz = group.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = todayInTimezone(tz);
    const nowTime = getCurrentTimeInTimezone(tz);
    const dateUtc = toUtcMidnight(todayStr);
    const grace = Math.max(0, group.attendanceGraceMinutes ?? 0);
    const floor = group.minOptOutMinutes ?? defaultFloor;

    // Live-Test-9 ISSUE-003: day entries via the shared PUBLISHED-day resolver
    // (frozen snapshot, publishedAt-gated, recurring-weekday fallback) — the
    // exact set /meals/today renders and marking enforces. The old live-entry
    // read (isPublished:true, exact date only) made the close sweep skip every
    // planner meal while an admin edit held the week in draft — no system
    // Skip/Present materialization, so non-responders were never recorded.
    const [meals, entryMap] = await Promise.all([
      this.prisma.meal.findMany({
        where: {
          groupId: group.id,
          organizationId: group.organizationId,
          attendanceEnabled: true,
        },
        select: {
          id: true,
          name: true,
          slotKey: true,
          isActive: true,
          preferencesEnabled: true,
          attendanceWindowOpen: true,
          attendanceWindowClose: true,
          price: true,
        },
      }),
      // ISSUE-002: attendance-only ignores the planner entirely (meal-system
      // machinery) — skip the published-day query, no entries to overlay.
      attendanceOnly
        ? Promise.resolve(new Map<string, PublishedDayEntry>())
        : resolvePublishedDayEntries(this.prisma, {
            groupId: group.id,
            organizationId: group.organizationId,
            dateStr: todayStr,
          }),
    ]);
    if (!meals.length) return;

    // Live-Test-8 ISSUE-006 (locked rule): the group-level Auto-Present policy
    // NEVER guesses a member's picks either — preference-required meals are
    // excluded from auto-Present exactly like personal auto-attendance
    // (ATT-011, day-effective: the published day entry can clear or enable
    // the requirement). System-SKIP materialization is unaffected — a Skip is
    // a recorded no-response and carries no preference selection.
    let hasGroups = new Set<string>();
    if (materializeStatus === 'present') {
      const boundGroups = await this.prisma.mealPreferenceGroup.findMany({
        where: {
          mealId: { in: meals.map((m) => m.id) },
          isActive: true,
        } as any,
        select: { mealId: true },
        distinct: ['mealId'],
      });
      hasGroups = new Set(boundGroups.map((b) => b.mealId));
    }

    // ISSUE-002: attendance-only never runs planner mode (same rule as the
    // /meals/today overlay and the marking path's plannerActive gate).
    const plannerActive =
      !attendanceOnly &&
      (group.weeklyMenuEnabled === true || group.dayWiseMealsEnabled === true);

    for (const meal of meals) {
      const entry = entryMap.get(meal.id);
      // Live-Test-9 ISSUE-002: archived meals stay in the close sweep ONLY
      // while the published snapshot carries them (planner mode); master-mode
      // archives take effect immediately (never billed after delete).
      if (meal.isActive === false && !plannerActive) continue;
      // FR-MODE-032: holiday / no-meal day in planner mode → never auto-bill.
      if (plannerActive && !entry) continue;

      // Live-Test-8 ISSUE-006: auto-Present NEVER guesses a member's picks —
      // preference-required meals (day-effective, same rule as the personal
      // auto-attendance sweep) are excluded from Present materialization.
      // When the group ALSO runs Bill-Skip, the no-response policy still
      // governs: such meals fall back to the system SKIP (a Skip carries no
      // preference selection); otherwise they simply stay unmarked.
      let mealStatus = materializeStatus;
      if (materializeStatus === 'present') {
        // P-01: a fully frozen published day decides from its FROZEN
        // preference block — switching a meal Standalone↔Group in Master no
        // longer changes auto-attendance eligibility for an already-published
        // day. Days that predate the freeze keep the live-binding rule verbatim.
        const dayFlatPrefs = entry?.configurationFrozen
          ? entry.preference?.enabled === true &&
            entry.preference?.mode === 'standalone'
          : (entry?.preferencesEnabled ?? meal.preferencesEnabled);
        const dayGroupPrefs = entry?.configurationFrozen
          ? entry.preference?.enabled === true &&
            entry.preference?.mode === 'group'
          : hasGroups.has(meal.id) && entry?.preferencesEnabled !== false;
        if (dayFlatPrefs === true || dayGroupPrefs) {
          // ISSUE-004: the meal still has to leave Pending, so it falls back to
          // the system SKIP in EVERY group now (not only Bill-Skip ones). The
          // Skip stays billing-neutral unless Bill-Skip is ON — decided by the
          // price snapshot below, never by inventing a preference selection.
          mealStatus = 'skipped';
        }
      }

      const open = entry?.openTime ? entry.openTime : meal.attendanceWindowOpen;
      const close = entry?.openTime
        ? entry.closeTime
        : meal.attendanceWindowClose;
      if (!open || !close) continue; // no bounded window → no fair close point

      // Only materialize once the window (incl. grace) has fully closed.
      if (getWindowState(nowTime, open, close, grace) !== 'closed') continue;

      // ISSUE-004 (locked rule): the System SKIP is assigned to EVERY member who
      // did not respond before the window closed — unconditionally. No extra
      // gate, no exceptions. Whether that Skip costs money is decided solely by
      // the group's EXISTING Skip Billing configuration, below.
      //
      // FR-TRUST-003's fairness gates (fair-opportunity floor here, reminder
      // check in materializeMeal) belong to the OPT-OUT auto-Present model —
      // they exist so nobody is recorded as having EATEN without a real chance to
      // opt out. They are untouched for 'present' and deliberately do not apply
      // to the System SKIP, which records the opposite (a non-response).
      if (mealStatus === 'present' && windowMinutes(open, close) < floor) {
        continue;
      }

      await this.materializeMeal({
        group,
        mealId: meal.id,
        mealName: meal.name,
        slotKey: (meal as any).slotKey ?? null,
        dateUtc,
        dateStr: todayStr,
        // Skip Billing configuration, unchanged:
        //   Skip Billed ON  → the System SKIP carries the scheduled price
        //                     snapshot and bills by the existing rules;
        //   Skip Billed OFF → price null ⇒ ₹0 in every money path, no billing.
        // ISSUE-002: attendance-only groups never bill at all (meal billing is
        // meal-system functionality and the meal system is OFF).
        price:
          attendanceOnly ||
          (mealStatus === 'skipped' && group.billSkippedMeals !== true)
            ? null
            : entry?.price != null
              ? entry.price
              : (meal.price ?? null),
        openTime: open,
        status: mealStatus,
      });
    }
  }

  private async materializeMeal(params: {
    group: { id: string; organizationId: string };
    mealId: string;
    mealName: string;
    /** ISSUE-005: boundary-identity vacation coverage (start/end meal). */
    slotKey?: string | null;
    dateUtc: Date;
    dateStr: string;
    price: number | null;
    openTime: string | null;
    /** 'present' = opt-out auto-Present policy · 'skipped' = the System SKIP. */
    status: 'present' | 'skipped';
  }): Promise<void> {
    const { group, mealId, dateUtc, dateStr, price, status } = params;

    // Sweep-level idempotency flag: each (meal, date) is materialized once —
    // members who mark/unmark afterwards are never re-defaulted, so a member
    // correction to Absent sticks (FR-TRUST-002).
    const onceKey = `sysdefault:done:${group.organizationId}:${mealId}:${dateStr}`;
    if (!(await this.redis.setDedup(onceKey, 48 * 60 * 60))) return;

    // FR-TRUST-003: was a reminder actually dispatched for this meal today?
    // (Flag set by AttendanceReminderWorker, 4h TTL — the sweep runs right
    // after close, well inside it.)
    // ISSUE-004: this gate neutralizes members who were promised a reminder that
    // never arrived, so they are not recorded as having EATEN without one. It is
    // therefore part of the auto-Present model only — the System SKIP records a
    // non-response and applies unconditionally, otherwise "unmarked ⇒ Skip"
    // would silently depend on reminder delivery and members would linger in
    // Pending exactly as reported.
    const reminderSent =
      status === 'skipped' ||
      (await this.redis.exists(
        `reminder:dispatched:schedule-reminder:${group.organizationId}:${mealId}:30min`,
      )) ||
      (await this.redis.exists(
        `reminder:dispatched:schedule-reminder:${group.organizationId}:${mealId}:10min`,
      ));

    const [members, existing] = await Promise.all([
      this.prisma.groupMember.findMany({
        where: {
          groupId: group.id,
          status: 'active',
        },
        select: {
          userId: true,
          // Per-group override rides the SAME row (no extra query); the user
          // flag below stays as the inherited fallback.
          isVacationMode: true,
          user: {
            select: {
              remindersEnabled: true,
              fcmToken: true,
              isVacationMode: true,
            },
          },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { mealId, attendanceDate: dateUtc },
        select: { userId: true },
      }),
    ]);

    // Pass 11 (FR-VACX-003/012): vacation exclusion is REQUEST-AWARE and
    // meal-granular — on a boundary day only the covered slots are exempt
    // from auto-billing; toggle-mode vacations exempt the whole day. Approved
    // requests govern even when the flag lags (never auto-bill a vacationer).
    const onVacation = await getVacationCoveredUserIds(this.prisma as any, {
      organizationId: group.organizationId,
      groupId: group.id,
      dateUtc,
      mealOpenTime: params.openTime,
      mealSlotKey: params.slotKey ?? null,
      candidates: members.map((m) => ({
        userId: m.userId,
        isVacationMode: resolveMemberFlag(m, m.user, 'isVacationMode'),
      })),
    });

    const already = new Set(existing.map((r) => r.userId));
    const eligible = members.filter(
      (m) =>
        !already.has(m.userId) &&
        !onVacation.has(m.userId) &&
        // No reminder went out → only members who waived reminders are
        // auto-marked; the rest are neutralized (fail-safe, FR-TRUST-003).
        (reminderSent || m.user.remindersEnabled === false),
    );
    if (!eligible.length) return;

    await this.prisma.attendanceRecord.createMany({
      data: eligible.map((m) => ({
        organizationId: group.organizationId,
        groupId: group.id,
        userId: m.userId,
        mealId,
        attendanceDate: dateUtc,
        status,
        markedAt: new Date(),
        markedBy: null,
        price,
        source: 'system_default',
      })),
      skipDuplicates: true, // races with self-marks: the member always wins
    });

    // Per-record audit so FR-TRUST-010 change history shows the system entry.
    const created = await this.prisma.attendanceRecord.findMany({
      where: {
        mealId,
        attendanceDate: dateUtc,
        source: 'system_default',
        userId: { in: eligible.map((m) => m.userId) },
      },
      select: { id: true, userId: true },
    });
    for (const rec of created) {
      this.audit.log({
        organizationId: group.organizationId,
        targetId: rec.id,
        targetType: 'Attendance',
        action: AuditAction.create,
        metadata: {
          source: 'system_default',
          status,
          // FR-TRUST-010 history: the row's own price snapshot says whether it
          // billed, so the reason is derived from it rather than a second flag.
          reason:
            status === 'present'
              ? 'Group opt-out policy — unmarked at window close'
              : price != null
                ? 'System Skip — no attendance submitted before window close (billed per Skip Billing policy)'
                : 'System Skip — no attendance submitted before window close (not billed)',
        },
      });
    }

    // Invalidate the same read caches the attendance service maintains —
    // INCLUDING the admin/student dashboard composites and the billing
    // version key (cache-parity with invalidateAttendanceCache; previously
    // auto-marks stayed invisible on dashboards for up to the 5-min TTL).
    const cacheKeys = [
      `attendance:group:${group.organizationId}:${group.id}:${dateStr}`,
      `attendance:meal:${group.organizationId}:${mealId}:${dateStr}`,
      `dashboard:admin:${group.organizationId}`,
      ...created.flatMap((r) => [
        `attendance:summary:${group.organizationId}:${r.userId}:${group.id}`,
        `dashboard:student:${group.organizationId}:${r.userId}`,
      ]),
    ];
    try {
      await this.redis.del(...cacheKeys);
    } catch (_) {
      /* cache invalidation is best-effort */
    }
    // Pass 12 (FR-BILLX-050): attendance writes bump the group's billing
    // version so cached billing summaries can never serve pre-sweep figures.
    try {
      await this.redis.set(`bill:ver:${group.id}`, Date.now().toString());
    } catch (_) {
      /* best-effort */
    }

    // Live dashboards: one group-room event per sweep batch (same event name
    // the attendance service emits) so open admin/student screens refresh
    // within seconds instead of waiting for the next cold load.
    try {
      this.gateway?.emitToGroup(group.id, 'attendance.updated.v1', {
        groupId: group.id,
        mealId,
        date: dateStr,
        source: 'system_default',
        count: created.length,
      });
    } catch (_) {
      /* realtime is best-effort */
    }

    // FR-TRUST-011: tell each affected member, with the easy way out.
    const byUser = new Map(members.map((m) => [m.userId, m]));
    const recipients = created
      .map((r) => byUser.get(r.userId))
      .filter((m) => m?.user.fcmToken)
      .map((m) => ({ userId: m!.userId, fcmToken: m!.user.fcmToken! }));
    if (recipients.length) {
      try {
        await this.queue.enqueueBatchPush({
          organizationId: group.organizationId,
          recipients,
          title: 'Marked Present by group policy',
          body:
            `${params.mealName} (${dateStr}): you were marked Present under your ` +
            'group’s opt-out policy. Didn’t eat? Correct it from the attendance screen.',
          // Registered frontend path (Issue 6: roleless routes 404'd in-app).
          route: '/student/attendance',
          data: { type: 'system_default_marked', mealId, date: dateStr },
        });
      } catch (err) {
        this.logger.warn(
          `system-default push enqueue failed: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `System-default sweep: group=${group.id} meal=${mealId} date=${dateStr} created=${created.length} reminderSent=${reminderSent}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(
      `SystemDefault job FAILED job=${job.id} attempts=${job.attemptsMade}: ${error.message}`,
      error.stack,
    );
  }
}
