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
 * Rolling, billing-aware 3-month retention per group:
 *
 *   Phase 1  normal operation until `retentionReviewAt` (first sweep touch
 *            initializes it to createdAt + RETENTION_MONTHS — RET-013).
 *   Phase 2  at review time, only data belonging to COMPLETED billing periods
 *            (everything before the CURRENT period) is eligible. Data in the
 *            active period is never touched (RET-003/004).
 *   Phase 3  while an unsettled bill exists, group admins get ONE reminder a
 *            day (bell + push) for reminderDays + graceDays (RET-005/006).
 *   Phase 4  after the grace deadline the system AUTO-finalizes + locks the
 *            outstanding span (RET-007).
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
    const groups = await this.prisma.group.findMany({
      where: {
        isActive: true,
        OR: [
          { retentionReviewAt: null }, // RET-013 bootstrap on first touch
          { retentionReviewAt: { lte: new Date() } },
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
        retentionReviewAt: true,
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

  private addMonths(d: Date, months: number): Date {
    const out = new Date(d.getTime());
    out.setUTCMonth(out.getUTCMonth() + months);
    return out;
  }

  private async processGroup(g: {
    id: string;
    organizationId: string;
    name: string;
    adminId: string | null;
    createdAt: Date;
    mealPricingEnabled: boolean;
    billingCycleStartDay: number | null;
    retentionReviewAt: Date | null;
    organization: { timezone: string | null } | null;
  }): Promise<void> {
    const months = this.cfg('months', 3);
    const now = new Date();

    // RET-013: bootstrap the rolling pointer on first touch.
    if (!g.retentionReviewAt) {
      await this.prisma.group.updateMany({
        where: { id: g.id },
        data: { retentionReviewAt: this.addMonths(g.createdAt, months) },
      });
      return;
    }
    if (now < g.retentionReviewAt) return; // Phase 1 — not due yet.

    const tz = g.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = todayInTimezone(tz);

    // RET-003/004: only COMPLETED periods are eligible — the cutoff is the
    // day before the CURRENT billing period starts (org-time cycle math).
    const current = this.billing.resolveCurrentPeriod(
      todayStr,
      g.billingCycleStartDay ?? null,
    );
    const cutoffEnd = new Date(
      toUtcMidnight(current.fromDate).getTime() - 24 * 60 * 60 * 1000,
    );

    // Nothing eligible → roll the review forward (RET-012).
    const eligibleRows = await this.prisma.attendanceRecord.count({
      where: {
        groupId: g.id,
        organizationId: g.organizationId,
        attendanceDate: { lte: cutoffEnd },
      },
    });
    if (eligibleRows === 0) {
      await this.rescheduleReview(g.id, months);
      return;
    }

    // Is the bill settled through the cutoff? (Non-priced groups have no
    // billing to settle — they proceed straight to archive at the deadline.)
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

    const reminderDays = this.cfg('reminderDays', 7);
    const graceDays = this.cfg('graceDays', 3);
    const deadline = new Date(
      g.retentionReviewAt.getTime() +
        (reminderDays + graceDays) * 24 * 60 * 60 * 1000,
    );

    // RET-003 corner case: a deliberately REOPENED period overlapping the
    // cutoff is an admin actively editing that bill — an "unfinished billing
    // period" in SRS terms. Never purge (or auto-finalize over) it; remind
    // daily and wait until the admin re-finalizes.
    if (g.mealPricingEnabled) {
      const reopened = await this.prisma.billingPeriod.findFirst({
        where: {
          groupId: g.id,
          organizationId: g.organizationId,
          status: 'reopened',
          periodStart: { lte: cutoffEnd },
        },
        select: { id: true },
      });
      if (reopened) {
        await this.sendDailyReminder(g, todayStr, fmt(cutoffEnd), deadline);
        return;
      }
    }

    if (needsFinalize && now < deadline) {
      // Phase 3/4 — daily reminder until the admin finalizes (RET-005/006).
      await this.sendDailyReminder(g, todayStr, fmt(cutoffEnd), deadline);
      return;
    }

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

    // Phase 5 steps 4–8 — archive, notify, purge, reschedule.
    await this.archiveAndPurge(g, cutoffEnd, months);
  }

  private async rescheduleReview(groupId: string, months: number): Promise<void> {
    await this.prisma.group.updateMany({
      where: { id: groupId },
      data: { retentionReviewAt: this.addMonths(new Date(), months) },
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
    months: number,
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
      await this.rescheduleReview(g.id, months);
      return;
    }
    const periodStart = attendance[0].attendanceDate;

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
      `successfully. Data older than ${months} months has been archived and ` +
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

    // 5. Purge (RET-011) — archive verified above, so deletion is safe.
    //    Audit rows tied to the purged records go with them (chunked).
    const attendanceIds = attendance.map((r) => r.id);
    await this.purgeAuditFor(orgId, attendanceIds);
    await this.purgeAuditFor(orgId, corrections.map((r: any) => r.id));

    await this.prisma.mealGuest.deleteMany({
      where: { groupId: g.id, organizationId: orgId, attendanceDate: { lte: cutoffEnd } },
    });
    await this.prisma.attendanceCorrectionRequest.deleteMany({
      where: { groupId: g.id, organizationId: orgId, attendanceDate: { lte: cutoffEnd } },
    });
    await (this.prisma as any).vacationRequest.deleteMany({
      where: { groupId: g.id, organizationId: orgId, endDate: { lte: cutoffEnd } },
    });
    await (this.prisma as any).billingLedgerEntry.deleteMany({
      where: { groupId: g.id, organizationId: orgId, entryDate: { lte: cutoffEnd } },
    });
    await this.prisma.notice.deleteMany({
      where: { groupId: g.id, organizationId: orgId, createdAt: { lte: cutoffEnd } },
    });
    await this.prisma.attendanceRecord.deleteMany({
      where: { groupId: g.id, organizationId: orgId, attendanceDate: { lte: cutoffEnd } },
    });
    // BillingPeriod rows are KEPT: they are the immutable finalized-bill
    // record and keep the period lock protecting archived dates.

    await (this.prisma as any).groupArchive.updateMany({
      where: { id: archive.id },
      data: { purgedAt: new Date() },
    });

    // 6. Reschedule (RET-012/015) + invalidate billing caches + audit.
    await this.rescheduleReview(g.id, months);
    await this.billing.bumpBillingVersion(g.id);
    this.audit.log({
      organizationId: orgId,
      targetId: archive.id,
      targetType: 'GroupArchive',
      action: AuditAction.create,
      metadata: {
        groupId: g.id,
        periodStart: fmt(periodStart),
        periodEnd: fmt(cutoffEnd),
        ...counts,
        reason: 'RET-011 — 3-month retention archive + production cleanup',
      },
    });
    this.logger.warn(
      `Retention purge complete group=${g.id} through=${fmt(cutoffEnd)} rows=${attendance.length}`,
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
