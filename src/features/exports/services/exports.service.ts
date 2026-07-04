import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';
import { AttendanceExportQueryDto, EventExportQueryDto } from '../dto/export-query.dto';

const ADMIN_ROLES = ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager'];

/**
 * Hard row cap for exports — prevents unbounded memory usage on large orgs.
 * 365 days × 1000 members × 3 meals ≈ 1M records → would OOM a 512MB PM2 instance.
 * At 50K rows (~150 bytes/row) ≈ 7.5MB in memory — safe for VPS 10.
 * Clients needing more data should use narrower date ranges or per-member filters.
 */
const MAX_EXPORT_ROWS = 50_000;

/**
 * ExportsService — CSV and XLSX data export for attendance + events.
 *
 * Rules:
 *   - Admin-only. Role check enforced before any query.
 *   - org isolation: all queries filter by organizationId from JWT.
 *   - No PDF — Flutter generates PDF from the raw data.
 *   - CSV: plain text, RFC 4180 compliant, streamed directly.
 *   - XLSX: binary via exceljs, streamed to response.
 *   - Date range capped at 365 days; row count capped at MAX_EXPORT_ROWS (50K).
 *
 * Library: exceljs (installed in phase B5), fast-csv for CSV streaming.
 * If libraries not installed, graceful fallback to manual CSV construction.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── ATTENDANCE EXPORT ─────────────────────────────────────────────────────

  async exportAttendance(
    adminId: string,
    organizationId: string,
    role: string,
    dto: AttendanceExportQueryDto,
    res: Response,
    requestId?: string,
  ): Promise<void> {
    this.assertAdmin(role);

    // Validate group ownership. Pass 15 (FR-MODE-042): mode flags ride the
    // same query — they decide which columns the export carries.
    const group = await this.prisma.group.findFirst({
      where: { id: dto.groupId, organizationId },
      select: {
        id: true,
        name: true,
        mealsEnabled: true,
        mealPricingEnabled: true,
        guestAttendanceEnabled: true,
      },
    });
    if (!group) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    const fromDate = parseLocalDate(dto.fromDate);
    const toDate = parseLocalDate(dto.toDate);
    this.validateDateRange(fromDate, toDate);

    const format = dto.format ?? 'csv';

    // Safety: count rows first — reject if over hard cap (prevents OOM on large orgs)
    const rowCount = await this.prisma.attendanceRecord.count({
      where: {
        organizationId,
        groupId: dto.groupId,
        attendanceDate: { gte: fromDate, lte: toDate },
        ...(dto.userId ? { userId: dto.userId } : {}),
      },
    });

    if (rowCount > MAX_EXPORT_ROWS) {
      throw new BadRequestException({
        message: 'Export too large',
        errors: {
          rows: `This export would return ${rowCount.toLocaleString()} rows which exceeds the ${MAX_EXPORT_ROWS.toLocaleString()} row limit. Narrow the date range or filter by a specific member.`,
        },
      });
    }

    // Fetch attendance records with user and meal info
    const records = await this.prisma.attendanceRecord.findMany({
      where: {
        organizationId,
        groupId: dto.groupId,
        attendanceDate: { gte: fromDate, lte: toDate },
        ...(dto.userId ? { userId: dto.userId } : {}),
      },
      orderBy: [{ attendanceDate: 'asc' }, { userId: 'asc' }],
      take: MAX_EXPORT_ROWS, // belt-and-suspenders cap in case count race
      include: {
        user: { select: { name: true, email: true, phone: true } },
        meal: { select: { slotKey: true, name: true, displayName: true } },
      },
    });

    // Build export rows. Pass 15 (FR-ANL-030): rows always carry every value
    // (price, per-preference-group selections) — the HEADER set decides what
    // is actually emitted, so gating costs nothing per row.
    // Multi-preference columns come from the SNAPSHOTTED selection JSON
    // (FR-PG-013/FR-ANL-022) — renamed options never corrupt past exports.
    const prefGroupLabels: string[] = [];
    const seenPrefGroups = new Set<string>();

    const rows: AttendanceExportRow[] = records.map((r: any) => {
      const row: AttendanceExportRow = {
        date: toDateString(r.attendanceDate),
        memberName: r.user?.name ?? 'Unknown',
        memberEmail: r.user?.email ?? '',
        memberPhone: r.user?.phone ?? '',
        mealSlot: r.meal?.slotKey ?? '',
        mealName: r.meal?.displayName ?? r.meal?.name ?? '',
        status: r.status,
        preference: r.preference ?? '',
        markedAt: r.markedAt ? r.markedAt.toISOString() : '',
        // FR-ANL-030: ₹ from the paise snapshot at mark time (blank = unpriced).
        price: r.price != null ? (r.price / 100).toFixed(2) : '',
        // FR-HG-060 (Pass 9): hosted-guest counters ride the same record —
        // denormalised on AttendanceRecord in Pass 8, so no extra query.
        guestAdults: String(r.guestAdults ?? 0),
        guestChildren: String(r.guestChildren ?? 0),
        guestsTotal: String((r.guestAdults ?? 0) + (r.guestChildren ?? 0)),
      };
      if (Array.isArray(r.preferences)) {
        for (const sel of r.preferences as Array<Record<string, unknown>>) {
          const label = typeof sel?.groupLabel === 'string' ? sel.groupLabel : null;
          if (!label) continue;
          if (!seenPrefGroups.has(label)) {
            seenPrefGroups.add(label);
            prefGroupLabels.push(label);
          }
          const key = `prefGroup:${label}`;
          const qty = typeof sel.quantity === 'number' && sel.quantity > 1 ? ` ×${sel.quantity}` : '';
          const value = `${sel.optionLabel ?? sel.optionKey ?? ''}${qty}`;
          row[key] = row[key] ? `${row[key]}; ${value}` : value;
        }
      }
      return row;
    });

    // Pass 15 (FR-MODE-042): mode-appropriate columns — AO omits meal /
    // preference / price; pricing adds the ₹ column; guest hosting adds the
    // guest columns; multi-preference selections add per-group columns.
    // Column ORDER for a priced-off MM group with guest hosting is byte-
    // identical to the legacy fixed header (existing consumers unaffected).
    const headers = buildAttendanceHeaders(
      {
        mealsEnabled: group.mealsEnabled !== false,
        pricingEnabled: group.mealPricingEnabled === true,
        guestsEnabled: group.guestAttendanceEnabled === true,
      },
      prefGroupLabels,
    );

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: dto.groupId,
      targetType: 'Group',
      action: 'export',
      metadata: { format, fromDate: dto.fromDate, toDate: dto.toDate, rowCount: rows.length },
      requestId,
    });

    const filename = `attendance_${group.name.replace(/\s+/g, '_')}_${dto.fromDate}_${dto.toDate}`;

    if (format === 'xlsx') {
      await this.streamXlsx(res, rows, headers, filename);
    } else {
      this.streamCsv(res, rows, headers, filename);
    }
  }

  // ── BILLING ROLLUP EXPORT (Pass 12, FR-BILLX-024) ─────────────────────────

  /**
   * Per-member billing rollup for a group + range: meals consumed, snapshot
   * amounts, guest charges, signed ledger adjustments, net total — the same
   * append-only arithmetic as /attendance/billing-summary (FR-BILLX-043:
   * export reconciles exactly with the API figures). Four indexed aggregate
   * queries — no per-member N+1, no row-count risk.
   */
  async exportBilling(
    adminId: string,
    organizationId: string,
    role: string,
    dto: AttendanceExportQueryDto,
    res: Response,
    requestId?: string,
  ): Promise<void> {
    this.assertAdmin(role);

    const group = await this.prisma.group.findFirst({
      where: { id: dto.groupId, organizationId },
      select: { id: true, name: true, billNoShowGuests: true },
    });
    if (!group) {
      throw new NotFoundException({
        message: 'Group not found',
        errors: { groupId: 'Group does not exist in your organization' },
      });
    }

    const fromDate = parseLocalDate(dto.fromDate);
    const toDate = parseLocalDate(dto.toDate);
    this.validateDateRange(fromDate, toDate);
    const format = dto.format ?? 'csv';

    const recordWhere = {
      organizationId,
      groupId: dto.groupId,
      attendanceDate: { gte: fromDate, lte: toDate },
    };
    const guestStatuses = group.billNoShowGuests
      ? ['booked', 'no_show']
      : ['booked'];

    const [members, statusAgg, guestAgg, ledgerAgg] = await Promise.all([
      this.prisma.groupMember.findMany({
        where: { groupId: dto.groupId, status: 'active' },
        include: {
          user: { select: { name: true, email: true, phone: true } },
        },
      }),
      this.prisma.attendanceRecord.groupBy({
        by: ['userId', 'status'],
        where: recordWhere,
        _count: { _all: true },
        _sum: { price: true },
      }),
      this.prisma.mealGuest.groupBy({
        by: ['hostUserId'],
        where: {
          organizationId,
          groupId: dto.groupId,
          attendanceDate: { gte: fromDate, lte: toDate },
          status: { in: guestStatuses },
          pendingApproval: false,
        },
        _count: { _all: true },
        _sum: { priceSnapshot: true },
      }),
      (this.prisma as any).billingLedgerEntry.groupBy({
        by: ['userId', 'type'],
        where: {
          organizationId,
          groupId: dto.groupId,
          entryDate: { gte: fromDate, lte: toDate },
        },
        _sum: { amount: true },
      }),
    ]);

    type Agg = {
      present: number;
      skipped: number;
      absent: number;
      vacation: number;
      mealAmount: number;
      guestCount: number;
      guestAmount: number;
      adjustments: number;
    };
    const byUser = new Map<string, Agg>();
    const agg = (uid: string): Agg => {
      const v =
        byUser.get(uid) ??
        ({ present: 0, skipped: 0, absent: 0, vacation: 0, mealAmount: 0, guestCount: 0, guestAmount: 0, adjustments: 0 } as Agg);
      byUser.set(uid, v);
      return v;
    };
    for (const s of statusAgg) {
      const v = agg(s.userId);
      if (s.status === 'present') {
        v.present = s._count._all;
        v.mealAmount = s._sum.price ?? 0;
      } else if (s.status === 'skipped') v.skipped = s._count._all;
      else if (s.status === 'absent') v.absent = s._count._all;
      else if (s.status === 'onVacation') v.vacation = s._count._all;
    }
    for (const g of guestAgg) {
      const v = agg(g.hostUserId);
      v.guestCount = g._count._all;
      v.guestAmount = g._sum.priceSnapshot ?? 0;
    }
    for (const l of ledgerAgg as Array<{ userId: string; type: string; _sum: { amount: number | null } }>) {
      const v = agg(l.userId);
      v.adjustments += (l._sum.amount ?? 0) * (l.type === 'debit' ? 1 : -1);
    }

    const meta = new Map(
      members.map((m) => [
        m.userId,
        {
          name: m.user?.name ?? m.userId,
          email: m.user?.email ?? '',
          phone: m.user?.phone ?? '',
        },
      ]),
    );
    const allIds = new Set<string>([...meta.keys(), ...byUser.keys()]);
    const money = (paise: number) => (paise / 100).toFixed(2);

    const rows: BillingExportRow[] = [...allIds]
      .map((uid) => {
        const v = byUser.get(uid) ?? agg(uid);
        const m = meta.get(uid);
        const net = v.mealAmount + v.guestAmount + v.adjustments;
        return {
          memberName: m?.name ?? uid,
          memberEmail: m?.email ?? '',
          memberPhone: m?.phone ?? '',
          presentCount: String(v.present),
          skippedCount: String(v.skipped),
          absentCount: String(v.absent),
          vacationDays: String(v.vacation),
          mealAmount: money(v.mealAmount),
          guestCount: String(v.guestCount),
          guestAmount: money(v.guestAmount),
          adjustments: money(v.adjustments),
          netTotal: money(net),
          _net: net,
        } as BillingExportRow & { _net: number };
      })
      .sort((a: any, b: any) => b._net - a._net)
      .map(({ _net, ...row }: any) => row);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: dto.groupId,
      targetType: 'Group',
      action: 'export',
      metadata: {
        format,
        kind: 'billing',
        fromDate: dto.fromDate,
        toDate: dto.toDate,
        rowCount: rows.length,
      },
      requestId,
    });

    const filename = `billing_${group.name.replace(/\s+/g, '_')}_${dto.fromDate}_${dto.toDate}`;
    if (format === 'xlsx') {
      await this.streamXlsx(res, rows, BILLING_HEADERS, filename);
    } else {
      this.streamCsv(res, rows, BILLING_HEADERS, filename);
    }
  }

  // ── EVENT EXPORT ──────────────────────────────────────────────────────────

  async exportEventGuests(
    adminId: string,
    organizationId: string,
    role: string,
    dto: EventExportQueryDto,
    res: Response,
    requestId?: string,
  ): Promise<void> {
    this.assertAdmin(role);

    const event = await this.prisma.event.findFirst({
      where: { id: dto.eventId, organizationId },
      select: { id: true, name: true },
    });
    if (!event) {
      throw new NotFoundException({
        message: 'Event not found',
        errors: { eventId: 'Event does not exist in your organization' },
      });
    }

    const format = dto.format ?? 'csv';

    // Safety: count rows first — reject if over hard cap
    const personCount = await this.prisma.eventPerson.count({
      where: { party: { eventId: dto.eventId } },
    });

    if (personCount > MAX_EXPORT_ROWS) {
      throw new BadRequestException({
        message: 'Export too large',
        errors: {
          rows: `This event has ${personCount.toLocaleString()} guests which exceeds the ${MAX_EXPORT_ROWS.toLocaleString()} row export limit.`,
        },
      });
    }

    // Fetch all guest persons with party info
    const persons = await this.prisma.eventPerson.findMany({
      where: { party: { eventId: dto.eventId } },
      orderBy: { createdAt: 'asc' },
      take: MAX_EXPORT_ROWS, // belt-and-suspenders cap
      include: {
        party: { select: { primaryName: true, joinedAt: true } },
        mealType: { select: { title: true } },
      },
    });

    const rows: EventGuestExportRow[] = persons.map((p: any) => ({
      partyPrimaryName: p.party?.primaryName ?? '',
      guestName: p.displayName,
      type: p.isAdult ? 'Adult' : 'Child',
      isPrimary: p.isPrimary ? 'Yes' : 'No',
      mealType: p.mealType?.title ?? '',
      mealPreference: p.mealPreference ?? '',
      isPresent: p.isPresent ? 'Yes' : 'No',
      joinedAt: p.party?.joinedAt?.toISOString() ?? '',
    }));

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: dto.eventId,
      targetType: 'Event',
      action: 'export',
      metadata: { format, rowCount: rows.length },
      requestId,
    });

    const filename = `event_guests_${event.name.replace(/\s+/g, '_')}`;

    if (format === 'xlsx') {
      await this.streamXlsx(res, rows, EVENT_HEADERS, filename);
    } else {
      this.streamCsv(res, rows, EVENT_HEADERS, filename);
    }
  }

  // ── CSV STREAMING ─────────────────────────────────────────────────────────

  private streamCsv(
    res: Response,
    rows: Record<string, string>[],
    headers: ExportHeader[],
    filename: string,
  ): void {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.setHeader('Cache-Control', 'no-store');

    // Header row
    const headerLine = headers.map((h) => escapeCsv(h.label)).join(',');
    res.write(headerLine + '\r\n');

    // Data rows
    for (const row of rows) {
      const line = headers.map((h) => escapeCsv(String(row[h.key] ?? ''))).join(',');
      res.write(line + '\r\n');
    }

    res.end();
  }

  // ── XLSX STREAMING ────────────────────────────────────────────────────────

  private async streamXlsx(
    res: Response,
    rows: Record<string, string>[],
    headers: ExportHeader[],
    filename: string,
  ): Promise<void> {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');

    try {
      // Dynamic import — exceljs is optional dependency
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Export');

      // Headers with bold styling
      sheet.columns = headers.map((h) => ({
        header: h.label,
        key: h.key,
        width: h.width ?? 20,
      }));
      sheet.getRow(1).font = { bold: true };

      // Data rows
      for (const row of rows) {
        sheet.addRow(row);
      }

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      this.logger.warn(`exceljs not available, falling back to CSV: ${err?.message}`);
      // Graceful fallback to CSV
      this.streamCsv(res, rows, headers, filename);
    }
  }

  // ── PRIVATE HELPERS ───────────────────────────────────────────────────────

  private assertAdmin(role: string): void {
    if (!ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: { role: 'Export requires manager or admin role' },
      });
    }
  }

  private validateDateRange(fromDate: Date, toDate: Date): void {
    if (fromDate > toDate) {
      throw new BadRequestException({
        message: 'Invalid date range',
        errors: { fromDate: 'fromDate must be before toDate' },
      });
    }
    const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 365) {
      throw new BadRequestException({
        message: 'Date range too large',
        errors: { toDate: 'Maximum export range is 365 days' },
      });
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExportHeader {
  key: string;
  label: string;
  width?: number;
}

interface AttendanceExportRow {
  [key: string]: string;
  date: string;
  memberName: string;
  memberEmail: string;
  memberPhone: string;
  mealSlot: string;
  mealName: string;
  status: string;
  preference: string;
  markedAt: string;
  price: string;
  guestAdults: string;
  guestChildren: string;
  guestsTotal: string;
}

interface EventGuestExportRow {
  [key: string]: string;
  partyPrimaryName: string;
  guestName: string;
  type: string;
  isPrimary: string;
  mealType: string;
  mealPreference: string;
  isPresent: string;
  joinedAt: string;
}

/**
 * Pass 15 (FR-MODE-042/FR-ANL-030): attendance export columns are built from
 * the group's mode flags. Attendance-Only groups omit meal / preference /
 * price columns entirely; pricing adds the ₹ column; guest hosting appends
 * the guest columns (Pass 9 position — always last); multi-dimensional
 * preference selections add one column per preference group, labelled with
 * the SNAPSHOTTED group label so historical exports survive renames.
 */
function buildAttendanceHeaders(
  flags: { mealsEnabled: boolean; pricingEnabled: boolean; guestsEnabled: boolean },
  prefGroupLabels: string[],
): ExportHeader[] {
  return [
    { key: 'date', label: 'Date', width: 14 },
    { key: 'memberName', label: 'Member Name', width: 25 },
    { key: 'memberEmail', label: 'Email', width: 30 },
    { key: 'memberPhone', label: 'Phone', width: 16 },
    ...(flags.mealsEnabled
      ? [
          { key: 'mealSlot', label: 'Meal Slot', width: 14 },
          { key: 'mealName', label: 'Meal Name', width: 20 },
        ]
      : []),
    { key: 'status', label: 'Status', width: 12 },
    ...(flags.mealsEnabled
      ? [{ key: 'preference', label: 'Preference', width: 14 }]
      : []),
    { key: 'markedAt', label: 'Marked At', width: 24 },
    ...(flags.pricingEnabled
      ? [{ key: 'price', label: 'Price (₹)', width: 12 }]
      : []),
    ...prefGroupLabels.map((label) => ({
      key: `prefGroup:${label}`,
      label: `Pref: ${label}`,
      width: 20,
    })),
    // Additive (Pass 9) — appended LAST so existing column positions never move.
    ...(flags.guestsEnabled
      ? [
          { key: 'guestAdults', label: 'Guest Adults', width: 13 },
          { key: 'guestChildren', label: 'Guest Children', width: 14 },
          { key: 'guestsTotal', label: 'Guests Total', width: 13 },
        ]
      : []),
  ];
}

interface BillingExportRow {
  [key: string]: string;
  memberName: string;
  memberEmail: string;
  memberPhone: string;
  presentCount: string;
  skippedCount: string;
  absentCount: string;
  vacationDays: string;
  mealAmount: string;
  guestCount: string;
  guestAmount: string;
  adjustments: string;
  netTotal: string;
}

// Pass 12 (FR-BILLX-024): amounts exported in rupees (2dp) from paise
// snapshots; adjustments are the signed append-only ledger total.
const BILLING_HEADERS: ExportHeader[] = [
  { key: 'memberName', label: 'Member Name', width: 25 },
  { key: 'memberEmail', label: 'Email', width: 30 },
  { key: 'memberPhone', label: 'Phone', width: 16 },
  { key: 'presentCount', label: 'Present', width: 10 },
  { key: 'skippedCount', label: 'Skipped', width: 10 },
  { key: 'absentCount', label: 'Absent', width: 10 },
  { key: 'vacationDays', label: 'Vacation Days', width: 14 },
  { key: 'mealAmount', label: 'Meal Amount', width: 14 },
  { key: 'guestCount', label: 'Guests', width: 10 },
  { key: 'guestAmount', label: 'Guest Amount', width: 14 },
  { key: 'adjustments', label: 'Adjustments', width: 14 },
  { key: 'netTotal', label: 'Net Total', width: 14 },
];

const EVENT_HEADERS: ExportHeader[] = [
  { key: 'partyPrimaryName', label: 'Party Name', width: 25 },
  { key: 'guestName', label: 'Guest Name', width: 25 },
  { key: 'type', label: 'Type', width: 10 },
  { key: 'isPrimary', label: 'Primary', width: 10 },
  { key: 'mealType', label: 'Meal Type', width: 20 },
  { key: 'mealPreference', label: 'Preference', width: 14 },
  { key: 'isPresent', label: 'Present', width: 10 },
  { key: 'joinedAt', label: 'Joined At', width: 24 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
