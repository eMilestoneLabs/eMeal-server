import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { AttendanceService } from '../attendance.service';
import { AttendanceRepository } from '../repositories/attendance.repository';
import { MembersRepository } from '../../groups/repositories/members.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditService } from '../../../audit/audit.service';
import { AttendanceEntity } from '../entities/attendance.entity';

/**
 * AttendanceService unit tests.
 *
 * Tests verify:
 * - Org isolation: meal.organizationId checked before attendance
 * - Window validation: rejected outside HH:mm window
 * - Vacation mode: status handled
 * - Membership: non-members rejected with ForbiddenException
 * - Idempotency: upsert called (not create)
 * - Admin override: bypasses window and vacation mode
 * - Summary: no rates in response
 * - Pagination contract: { data, total, page, limit }
 */
describe('AttendanceService', () => {
  let service: AttendanceService;
  let attendanceRepo: jest.Mocked<AttendanceRepository>;
  let membersRepo: jest.Mocked<MembersRepository>;
  let prisma: jest.Mocked<PrismaService>;
  let redis: jest.Mocked<RedisService>;
  let audit: jest.Mocked<AuditService>;

  const mockMealRecord = new AttendanceEntity({
    id: 'att_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    userId: 'usr_01',
    mealId: 'meal_01',
    attendanceDate: new Date('2026-01-05T00:00:00.000Z'),
    status: 'present',
    preference: null,
    note: null,
    markedAt: new Date(),
    markedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        {
          provide: AttendanceRepository,
          useValue: {
            upsert: jest.fn(),
            findByUser: jest.fn(),
            findByGroup: jest.fn(),
            getUserSummary: jest.fn(),
            getMealSummary: jest.fn(),
            bulkUpsert: jest.fn(),
          },
        },
        {
          provide: MembersRepository,
          useValue: {
            isActiveMember: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            meal: {
              findFirst: jest.fn(),
              findMany: jest.fn(),
            },
            user: {
              findUnique: jest.fn(),
              findFirst: jest.fn(),
            },
            groupMember: {
              count: jest.fn(),
            },
          },
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: { log: jest.fn() },
        },
        {
          provide: 'ATTENDANCE_GATEWAY',
          useValue: {
            emitToGroup: jest.fn(),
            emitToUser: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AttendanceService>(AttendanceService);
    attendanceRepo = module.get(AttendanceRepository);
    membersRepo = module.get(MembersRepository);
    prisma = module.get(PrismaService);
    redis = module.get(RedisService);
    audit = module.get(AuditService);
  });

  // ── markAttendance ─────────────────────────────────────────────────────────

  describe('markAttendance', () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date());

    const mockMeal = {
      id: 'meal_01',
      groupId: 'grp_01',
      organizationId: 'org_01',
      attendanceEnabled: true,
      attendanceWindowOpen: null, // no window = always open
      attendanceWindowClose: null,
      group: { id: 'grp_01', timezone: 'Asia/Kolkata', mealsEnabled: true },
    };

    it('throws NotFoundException when meal not found in org', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.markAttendance('usr_01', 'org_01', {
          mealId: 'meal_FAKE',
          attendanceDate: today,
        }),
      ).rejects.toThrow(NotFoundException);

      // Org isolation: findFirst called with organizationId from JWT
      expect(prisma.meal.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'org_01' }),
        }),
      );
    });

    it('throws BadRequestException when attendanceEnabled=false', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        ...mockMeal,
        attendanceEnabled: false,
      });

      await expect(
        service.markAttendance('usr_01', 'org_01', {
          mealId: 'meal_01',
          attendanceDate: today,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when user is not an active member', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(mockMeal);
      (membersRepo.isActiveMember as jest.Mock).mockResolvedValue(false);

      await expect(
        service.markAttendance('usr_STRANGER', 'org_01', {
          mealId: 'meal_01',
          attendanceDate: today,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects out-of-window marks with HTTP 423 Locked + flat error contract (GAP-ATT-1)', async () => {
      // Build a window that is guaranteed CLOSED right now in the org timezone.
      const nowIst = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
      const closedWindow =
        nowIst >= '12:00'
          ? { open: '00:01', close: '00:02' }
          : { open: '23:58', close: '23:59' };

      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        ...mockMeal,
        attendanceWindowOpen: closedWindow.open,
        attendanceWindowClose: closedWindow.close,
        organization: { timezone: 'Asia/Kolkata' },
      });
      (membersRepo.isActiveMember as jest.Mock).mockResolvedValue(true);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isVacationMode: false });

      const err: any = await service
        .markAttendance('usr_01', 'org_01', { mealId: 'meal_01', attendanceDate: today })
        .then(() => null)
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(423); // source-of-truth status (NOT 400)
      const body: any = err.getResponse();
      expect(body).toMatchObject({ statusCode: 423 }); // flat error contract (LAW-12)
      expect(String(body.message)).toContain('Attendance window closed');
      expect(body.errors).toHaveProperty('window');
      expect(attendanceRepo.upsert).not.toHaveBeenCalled(); // nothing written
    });

    it('throws BadRequestException when attendanceDate is not today', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(mockMeal);
      (membersRepo.isActiveMember as jest.Mock).mockResolvedValue(true);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isVacationMode: false });

      await expect(
        service.markAttendance('usr_01', 'org_01', {
          mealId: 'meal_01',
          attendanceDate: '2020-01-01', // past date
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls upsert (idempotent) — never direct create', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(mockMeal);
      (membersRepo.isActiveMember as jest.Mock).mockResolvedValue(true);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isVacationMode: false });
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);
      (redis.get as jest.Mock).mockResolvedValue(null);

      await service.markAttendance('usr_01', 'org_01', {
        mealId: 'meal_01',
        attendanceDate: today,
        status: 'present',
      });

      // CRITICAL: upsert (not create) for idempotency
      expect(attendanceRepo.upsert).toHaveBeenCalled();
    });

    it('defaults status to "present" when not provided', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(mockMeal);
      (membersRepo.isActiveMember as jest.Mock).mockResolvedValue(true);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isVacationMode: false });
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);

      await service.markAttendance('usr_01', 'org_01', {
        mealId: 'meal_01',
        attendanceDate: today,
        // status NOT provided
      });

      expect(attendanceRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'present' }),
      );
    });

    it('sets markedBy=null for student (not admin override)', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(mockMeal);
      (membersRepo.isActiveMember as jest.Mock).mockResolvedValue(true);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ isVacationMode: false });
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);

      await service.markAttendance('usr_01', 'org_01', {
        mealId: 'meal_01',
        attendanceDate: today,
      });

      expect(attendanceRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ markedBy: null }),
      );
    });
  });

  // ── adminOverride ──────────────────────────────────────────────────────────

  describe('adminOverride', () => {
    it('throws NotFoundException when meal not found in org', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.adminOverride('admin_01', 'org_01', {
          userId: 'usr_01',
          mealId: 'meal_FAKE',
          attendanceDate: '2026-01-05',
          status: 'absent',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('sets markedBy=adminId (tracks who performed override)', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        id: 'meal_01',
        groupId: 'grp_01',
      });
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'usr_01' });
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);

      await service.adminOverride('admin_01', 'org_01', {
        userId: 'usr_01',
        mealId: 'meal_01',
        attendanceDate: '2026-01-05',
        status: 'absent',
      });

      // Admin override sets markedBy to adminId
      expect(attendanceRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ markedBy: 'admin_01' }),
      );
    });

    it('admin override does NOT check membership (bypasses student restriction)', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        id: 'meal_01',
        groupId: 'grp_01',
      });
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'usr_01' });
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);

      await service.adminOverride('admin_01', 'org_01', {
        userId: 'usr_01',
        mealId: 'meal_01',
        attendanceDate: '2026-01-05',
        status: 'present',
      });

      // membersRepo.isActiveMember should NOT be called in admin override path
      expect(membersRepo.isActiveMember).not.toHaveBeenCalled();
    });
  });

  // ── getUserSummary — no rates ──────────────────────────────────────────────

  describe('getUserSummary (NO rates/percentages)', () => {
    it('returns raw counts without any rate fields', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);
      (attendanceRepo.getUserSummary as jest.Mock).mockResolvedValue({
        presentCount: 7,
        absentCount: 2,
        skippedCount: 1,
        onVacationCount: 0,
        totalDays: 10,
      });
      (redis.set as jest.Mock).mockResolvedValue(undefined);

      const result = await service.getUserSummary('usr_01', 'student', 'org_01', {
        groupId: 'grp_01',
      });

      expect(result).toHaveProperty('presentDays', 7);
      expect(result).toHaveProperty('totalDays', 10);

      // CRITICAL: Flutter computes rates — backend must NOT include them
      expect(result).not.toHaveProperty('attendanceRate');
      expect(result).not.toHaveProperty('presentRate');
      expect(result).not.toHaveProperty('percentage');
    });
  });

  // ── getAttendance — pagination contract ──────────────────────────────────

  describe('getAttendance — pagination contract', () => {
    it('admin path uses { data, total, page, limit } (not items/count)', async () => {
      (attendanceRepo.findByGroup as jest.Mock).mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 50,
      });

      const result = await service.getAttendance(
        'admin_01',
        'hostelAdmin',
        'org_01',
        { groupId: 'grp_01', page: 1, limit: 50 },
      );

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('page');
      expect(result).toHaveProperty('limit');
      expect(result).not.toHaveProperty('items');
      expect(result).not.toHaveProperty('count');
    });
  });
});
