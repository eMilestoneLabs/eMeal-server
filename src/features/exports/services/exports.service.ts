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

    // Validate group ownership
    const group = await this.prisma.group.findFirst({
      where: { id: dto.groupId, organizationId },
      select: { id: true, name: true },
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

    // Build export rows
    const rows: AttendanceExportRow[] = records.map((r: any) => ({
      date: toDateString(r.attendanceDate),
      memberName: r.user?.name ?? 'Unknown',
      memberEmail: r.user?.email ?? '',
      memberPhone: r.user?.phone ?? '',
      mealSlot: r.meal?.slotKey ?? '',
      mealName: r.meal?.displayName ?? r.meal?.name ?? '',
      status: r.status,
      preference: r.preference ?? '',
      markedAt: r.markedAt ? r.markedAt.toISOString() : '',
    }));

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
      await this.streamXlsx(res, rows, ATTENDANCE_HEADERS, filename);
    } else {
      this.streamCsv(res, rows, ATTENDANCE_HEADERS, filename);
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

const ATTENDANCE_HEADERS: ExportHeader[] = [
  { key: 'date', label: 'Date', width: 14 },
  { key: 'memberName', label: 'Member Name', width: 25 },
  { key: 'memberEmail', label: 'Email', width: 30 },
  { key: 'memberPhone', label: 'Phone', width: 16 },
  { key: 'mealSlot', label: 'Meal Slot', width: 14 },
  { key: 'mealName', label: 'Meal Name', width: 20 },
  { key: 'status', label: 'Status', width: 12 },
  { key: 'preference', label: 'Preference', width: 14 },
  { key: 'markedAt', label: 'Marked At', width: 24 },
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
