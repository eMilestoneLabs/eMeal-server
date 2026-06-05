/**
 * export.service.spec.ts — B5 Phase
 *
 * Unit tests for ExportsService.
 * Verifies: role checks, org isolation, date range validation.
 * Does NOT test actual file streaming (integration test territory).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { ExportsService } from '../services/exports.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../../audit/audit.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  group: {
    findFirst: jest.fn(),
  },
  event: {
    findFirst: jest.fn(),
  },
  attendanceRecord: {
    findMany: jest.fn(),
  },
  eventPerson: {
    findMany: jest.fn(),
  },
};

const mockAudit = {
  log: jest.fn(),
};

describe('ExportsService', () => {
  let service: ExportsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<ExportsService>(ExportsService);
    jest.clearAllMocks();
  });

  // ── Role enforcement ───────────────────────────────────────────────────────

  it('exportAttendance rejects non-admin roles', async () => {
    await expect(
      service.exportAttendance('u1', 'org-1', 'student', {
        groupId: 'g-1',
        fromDate: '2026-01-01',
        toDate: '2026-01-31',
      } as any, {} as any),
    ).rejects.toThrow(ForbiddenException);
  });

  it('exportEventGuests rejects non-admin roles', async () => {
    await expect(
      service.exportEventGuests('u1', 'org-1', 'eventGuest', {
        eventId: 'ev-1',
      } as any, {} as any),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── Org isolation ──────────────────────────────────────────────────────────

  it('exportAttendance throws 404 if group not in org', async () => {
    mockPrisma.group.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.exportAttendance('admin-1', 'org-1', 'hostelAdmin', {
        groupId: 'other-org-group',
        fromDate: '2026-01-01',
        toDate: '2026-01-31',
      } as any, {} as any),
    ).rejects.toThrow(NotFoundException);

    // Verify org isolation — query used organizationId
    expect(mockPrisma.group.findFirst).toHaveBeenCalledWith({
      where: { id: 'other-org-group', organizationId: 'org-1' },
      select: expect.any(Object),
    });
  });

  it('exportEventGuests throws 404 if event not in org', async () => {
    mockPrisma.event.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.exportEventGuests('admin-1', 'org-1', 'hostelAdmin', {
        eventId: 'other-org-event',
      } as any, {} as any),
    ).rejects.toThrow(NotFoundException);

    expect(mockPrisma.event.findFirst).toHaveBeenCalledWith({
      where: { id: 'other-org-event', organizationId: 'org-1' },
      select: expect.any(Object),
    });
  });

  // ── Date range validation ──────────────────────────────────────────────────

  it('exportAttendance throws 400 if fromDate > toDate', async () => {
    mockPrisma.group.findFirst.mockResolvedValueOnce({ id: 'g-1', name: 'Test Group' });

    await expect(
      service.exportAttendance('admin-1', 'org-1', 'hostelAdmin', {
        groupId: 'g-1',
        fromDate: '2026-01-31',
        toDate: '2026-01-01',
      } as any, {} as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('exportAttendance throws 400 if date range > 365 days', async () => {
    mockPrisma.group.findFirst.mockResolvedValueOnce({ id: 'g-1', name: 'Test Group' });

    await expect(
      service.exportAttendance('admin-1', 'org-1', 'hostelAdmin', {
        groupId: 'g-1',
        fromDate: '2024-01-01',
        toDate: '2026-01-01',
      } as any, {} as any),
    ).rejects.toThrow(BadRequestException);
  });
});
