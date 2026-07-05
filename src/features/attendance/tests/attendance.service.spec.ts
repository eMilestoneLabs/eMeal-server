import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PreferencesService } from '../../preferences/preferences.service';
import { AttendanceService } from '../attendance.service';
import { AttendanceRepository } from '../repositories/attendance.repository';
import { MembersRepository } from '../../groups/repositories/members.repository';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditService } from '../../../audit/audit.service';
import { BillingService } from '../../billing/billing.service';
import { NotificationsService } from '../../notifications/notifications.service';
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
  let billing: { isDateFinalized: jest.Mock };
  let notifications: { notifyAttendanceChanged: jest.Mock };
  let config: { get: jest.Mock };

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
          provide: PreferencesService,
          useValue: {
            // Module 36: default = no explicit groups -> legacy path everywhere.
            getEffectiveGroupsForMeal: jest.fn().mockResolvedValue([]),
            getEffectiveGroupsForMeals: jest.fn().mockResolvedValue(new Map()),
            validateSelections: jest.fn(),
          },
        },
        {
          provide: AttendanceRepository,
          useValue: {
            upsert: jest.fn(),
            findByUser: jest.fn(),
            findByGroup: jest.fn(),
            findByKey: jest.fn(),
            getUserSummary: jest.fn(),
            getMealSummary: jest.fn(),
            bulkUpsert: jest.fn(),
          },
        },
        {
          provide: MembersRepository,
          useValue: {
            isActiveMember: jest.fn(),
            // Pass 10 (FR-MEMX-006): mark path re-checks full membership
            // state at submit — default to an active member.
            findMembership: jest.fn().mockResolvedValue({ status: 'active' }),
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
            // Planner per-day window overlay — null = no override (master
            // meal window applies), matching groups without a published plan.
            scheduleEntry: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
            // Approved-vacation exclusion in summaries — none by default.
            vacationRequest: {
              findMany: jest.fn().mockResolvedValue([]),
            },
            // Module 33 member confirmations (FR-OVR-020).
            attendanceCorrectionRequest: {
              findFirst: jest.fn().mockResolvedValue(null),
              create: jest.fn(),
            },
            // Pass 7 — dedup lookups + FR-TRUST-010 history.
            attendanceRecord: {
              findFirst: jest.fn().mockResolvedValue(null),
              findMany: jest.fn().mockResolvedValue([]),
            },
            auditLog: {
              findMany: jest.fn().mockResolvedValue([]),
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
          // Module 33 tunables (ACR expiry etc.) — defaults are fine here.
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
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
        {
          // Pass 7 — FR-DISP-010 period lock (unlocked by default).
          provide: BillingService,
          useValue: {
            isDateFinalized: jest.fn().mockResolvedValue({ locked: false }),
          },
        },
        {
          // Pass 7 — FR-TRUST-011 member notify (fire-and-forget).
          provide: NotificationsService,
          useValue: { notifyAttendanceChanged: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<AttendanceService>(AttendanceService);
    attendanceRepo = module.get(AttendanceRepository);
    membersRepo = module.get(MembersRepository);
    prisma = module.get(PrismaService);
    redis = module.get(RedisService);
    audit = module.get(AuditService);
    billing = module.get(BillingService);
    notifications = module.get(NotificationsService);
    config = module.get(ConfigService);
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
      ((membersRepo as any).findMembership as jest.Mock).mockResolvedValue(null);

      await expect(
        service.markAttendance('usr_STRANGER', 'org_01', {
          mealId: 'meal_01',
          attendanceDate: today,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    // Pass 10 — FR-MEMX-002/006 (LOOP-026) + FR-GRP-014 (SC-006).

    it('blocked members get the canonical MEMBER_BLOCKED 403', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(mockMeal);
      ((membersRepo as any).findMembership as jest.Mock).mockResolvedValue({
        status: 'blocked',
      });

      await expect(
        service.markAttendance('usr_01', 'org_01', {
          mealId: 'meal_01',
          attendanceDate: today,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'MEMBER_BLOCKED' }),
      });
    });

    it('archived groups reject in-flight marks with GROUP_ARCHIVED', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        ...mockMeal,
        group: { ...mockMeal.group, isActive: false },
      });

      await expect(
        service.markAttendance('usr_01', 'org_01', {
          mealId: 'meal_01',
          attendanceDate: today,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GROUP_ARCHIVED' }),
      });
      expect(attendanceRepo.upsert).not.toHaveBeenCalled();
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

    // ── FR-OVR-001 / FR-FAIR-010 (Module 33): Δliability classifier ─────────

    const pricedMeal = {
      id: 'meal_01',
      groupId: 'grp_01',
      price: 60,
      group: { mealPricingEnabled: true },
    };

    it('liability INCREASE (none→present, priced) is NOT applied — creates a member confirmation', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(pricedMeal);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'usr_01' });
      (attendanceRepo.findByKey as jest.Mock).mockResolvedValue(null); // no record
      ((prisma as any).attendanceCorrectionRequest.create as jest.Mock).mockResolvedValue({
        id: 'acr_01',
        status: 'pending',
        requestType: 'claim_present',
        sourceChannel: 'admin_prompt',
        userId: 'usr_01',
        mealId: 'meal_01',
        attendanceDate: new Date('2026-01-05T00:00:00.000Z'),
        expiresAt: new Date('2026-01-07T00:00:00.000Z'),
      });

      const result: any = await service.adminOverride('admin_01', 'org_01', {
        userId: 'usr_01',
        mealId: 'meal_01',
        attendanceDate: '2026-01-05',
        status: 'present',
      });

      expect(result.requiresMemberConsent).toBe(true);
      expect(result.correctionRequest.sourceChannel).toBe('admin_prompt');
      // The attendance record (and therefore the bill) must NOT change.
      expect(attendanceRepo.upsert).not.toHaveBeenCalled();
    });

    it('SELF-override (admin marks own present, priced) applies directly — no member confirmation', async () => {
      // command_3 bug: an admin marking their OWN attendance is self-consenting;
      // it must NOT be routed through the FR-OVR-001 confirmation path (which
      // returned requiresMemberConsent and blocked the admin from marking).
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(pricedMeal);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'admin_01' });
      (attendanceRepo.findByKey as jest.Mock).mockResolvedValue(null); // no record yet
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);

      const result: any = await service.adminOverride('admin_01', 'org_01', {
        userId: 'admin_01', // same as adminId → self
        mealId: 'meal_01',
        attendanceDate: '2026-01-05',
        status: 'present',
      });

      expect(result.requiresMemberConsent).toBeUndefined();
      expect(attendanceRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'present', source: 'admin' }),
      );
    });

    it('liability DECREASE (present→absent, priced) applies immediately', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(pricedMeal);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'usr_01' });
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);

      await service.adminOverride('admin_01', 'org_01', {
        userId: 'usr_01',
        mealId: 'meal_01',
        attendanceDate: '2026-01-05',
        status: 'absent',
      });

      expect(attendanceRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'absent', source: 'admin' }),
      );
    });

    it('present→present (already billed, priced) is neutral and applies', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue(pricedMeal);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'usr_01' });
      (attendanceRepo.findByKey as jest.Mock).mockResolvedValue({
        ...mockMealRecord,
        status: 'present',
      });
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);

      await service.adminOverride('admin_01', 'org_01', {
        userId: 'usr_01',
        mealId: 'meal_01',
        attendanceDate: '2026-01-05',
        status: 'present',
      });

      expect(attendanceRepo.upsert).toHaveBeenCalled();
    });

    it('unpriced groups keep the original unrestricted override behavior', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        id: 'meal_01',
        groupId: 'grp_01',
        price: null,
        group: { mealPricingEnabled: false },
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

      expect(attendanceRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'present', markedBy: 'admin_01' }),
      );
    });

    // ── Pass 7: LOOP-024 bounded backfill + FR-DISP-010 period lock ─────────

    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date());

    it('rejects overrides for future dates (LOOP-024)', async () => {
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        id: 'meal_01',
        groupId: 'grp_01',
      });
      const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      await expect(
        service.adminOverride('admin_01', 'org_01', {
          userId: 'usr_01',
          mealId: 'meal_01',
          attendanceDate: future,
          status: 'absent',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(attendanceRepo.upsert).not.toHaveBeenCalled();
    });

    it('rejects overrides older than adminBackfillDays (LOOP-024)', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'attendance.adminBackfillDays' ? 30 : undefined,
      );
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        id: 'meal_01',
        groupId: 'grp_01',
      });

      await expect(
        service.adminOverride('admin_01', 'org_01', {
          userId: 'usr_01',
          mealId: 'meal_01',
          attendanceDate: '2026-01-05', // ~180 days back
          status: 'absent',
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'BACKFILL_LIMIT' }),
      });
    });

    it('rejects writes into a FINALIZED billing period with 423 PERIOD_FINALIZED (FR-DISP-010)', async () => {
      billing.isDateFinalized.mockResolvedValue({
        locked: true,
        periodEnd: todayStr,
      });
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        id: 'meal_01',
        groupId: 'grp_01',
      });

      await expect(
        service.adminOverride('admin_01', 'org_01', {
          userId: 'usr_01',
          mealId: 'meal_01',
          attendanceDate: todayStr,
          status: 'absent',
        }),
      ).rejects.toMatchObject({
        status: 423,
        response: expect.objectContaining({ code: 'PERIOD_FINALIZED' }),
      });
      expect(attendanceRepo.upsert).not.toHaveBeenCalled();
    });

    // ── Pass 7: FR-TRUST-011 notify + LOOP-031 self-action flag ─────────────

    it('notifies the member on a non-self change; flags admin self-actions in audit', async () => {
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
        attendanceDate: todayStr,
        status: 'absent',
      });
      expect(notifications.notifyAttendanceChanged).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'usr_01', newStatus: 'absent' }),
      );

      // Self-action: no member notify, but the audit row carries the flag.
      notifications.notifyAttendanceChanged.mockClear();
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'admin_01' });
      await service.adminOverride('admin_01', 'org_01', {
        userId: 'admin_01',
        mealId: 'meal_01',
        attendanceDate: todayStr,
        status: 'absent',
      });
      expect(notifications.notifyAttendanceChanged).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ selfAction: true }),
        }),
      );
    });
  });

  // ── Pass 7: FR-ATT-033 governed bulk override ──────────────────────────────

  describe('adminBulkOverride', () => {
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date());

    it('applies decreases and holds increases per row (LOOP-025)', async () => {
      // Priced meal → none→present is an increase; absent is a decrease.
      (prisma.meal.findFirst as jest.Mock).mockResolvedValue({
        id: 'meal_01',
        groupId: 'grp_01',
        price: 60,
        group: { mealPricingEnabled: true },
      });
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'usr_01' });
      (attendanceRepo.findByKey as jest.Mock).mockResolvedValue(null);
      (attendanceRepo.upsert as jest.Mock).mockResolvedValue(mockMealRecord);
      (redis.del as jest.Mock).mockResolvedValue(undefined);
      ((prisma as any).attendanceCorrectionRequest.create as jest.Mock).mockResolvedValue({
        id: 'acr_bulk_01',
        status: 'pending',
        requestType: 'claim_present',
        sourceChannel: 'admin_prompt',
        userId: 'usr_02',
        mealId: 'meal_01',
        attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });

      const result = await service.adminBulkOverride('admin_01', 'org_01', {
        rows: [
          { userId: 'usr_01', mealId: 'meal_01', attendanceDate: todayStr, status: 'absent' },
          { userId: 'usr_02', mealId: 'meal_01', attendanceDate: todayStr, status: 'present' },
        ],
      });

      expect(result.applied).toBe(1);
      expect(result.requiresConsent).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.results[0]).toMatchObject({ outcome: 'applied' });
      expect(result.results[1]).toMatchObject({
        outcome: 'requiresConsent',
        correctionRequestId: 'acr_bulk_01',
      });
    });

    it('enforces the configurable row cap (LOOP-032 partial control)', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'attendance.bulkOverrideMaxRows' ? 2 : undefined,
      );
      const row = {
        userId: 'usr_01',
        mealId: 'meal_01',
        attendanceDate: todayStr,
        status: 'absent',
      };
      await expect(
        service.adminBulkOverride('admin_01', 'org_01', {
          rows: [row, row, row],
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'BULK_ROW_LIMIT' }),
      });
    });
  });

  // ── Pass 7: FR-TRUST-010 record change history ─────────────────────────────

  describe('getRecordHistory', () => {
    it('members can only view their own record history', async () => {
      ((prisma as any).attendanceRecord.findFirst as jest.Mock).mockResolvedValue({
        id: 'att_01',
        userId: 'someone_else',
        groupId: 'grp_01',
        mealId: 'meal_01',
        attendanceDate: new Date('2026-07-01T00:00:00.000Z'),
        status: 'present',
        source: 'self',
        sourceRequestId: null,
        markedBy: null,
        markedAt: new Date(),
        price: null,
      });

      await expect(
        service.getRecordHistory('usr_01', 'student', 'org_01', 'att_01'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('renders system-default entries with a system actor (FR-TRUST-010)', async () => {
      ((prisma as any).attendanceRecord.findFirst as jest.Mock).mockResolvedValue({
        id: 'att_01',
        userId: 'usr_01',
        groupId: 'grp_01',
        mealId: 'meal_01',
        attendanceDate: new Date('2026-07-01T00:00:00.000Z'),
        status: 'present',
        source: 'system_default',
        sourceRequestId: null,
        markedBy: null,
        markedAt: new Date(),
        price: 60,
      });
      ((prisma as any).auditLog.findMany as jest.Mock).mockResolvedValue([
        {
          actorId: null,
          action: 'create',
          metadata: {
            source: 'system_default',
            status: 'present',
            reason: 'Group opt-out policy — unmarked at window close',
          },
          createdAt: new Date('2026-07-01T09:05:00.000Z'),
        },
      ]);

      const result = await service.getRecordHistory(
        'usr_01', 'student', 'org_01', 'att_01',
      );
      expect(result.record.source).toBe('system_default');
      expect(result.history[0]).toMatchObject({
        actorKind: 'system',
        status: 'present',
      });
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

  describe('getGroupVacationMembers — input hardening', () => {
    it('rejects a malformed date with 400 (never reaches Prisma as Invalid Date)', async () => {
      await expect(
        service.getGroupVacationMembers(
          'org_01',
          'grp_01',
          "2026-07-05';DROP TABLE notices;--",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a missing groupId with 400', async () => {
      await expect(
        service.getGroupVacationMembers('org_01', '', '2026-07-05'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
