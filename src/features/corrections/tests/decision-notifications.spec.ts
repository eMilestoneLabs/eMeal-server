import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditService } from '../../../audit/audit.service';
import { MembersRepository } from '../../groups/repositories/members.repository';
import { AttendanceService } from '../../attendance/attendance.service';
import { AttendanceRepository } from '../../attendance/repositories/attendance.repository';
import { NotificationsService } from '../../notifications/notifications.service';
import { NoticesService } from '../../notices/notices.service';
import { PreferencesService } from '../../preferences/preferences.service';
import { CorrectionsService } from '../corrections.service';
import { CorrectionRequestsRepository } from '../repositories/correction-requests.repository';
import { GuestsService } from '../../guests/guests.service';
import { BillingService } from '../../billing/billing.service';

/**
 * Live-Test-14 ISSUE-001 + ISSUE-005 — the DECISION-DIRECTION contract.
 *
 * These two issues were reported as user-visible absences ("admin's own
 * correction still waits for approval", "the student never hears the outcome"),
 * so the guarantees are pinned here at the service level rather than left to
 * code reading:
 *
 *   ISSUE-001  an ADMIN's own correction is applied on creation — it never
 *              parks pending (it could not be approved at all: FR-ACR-010
 *              forbids self-approval), while a MEMBER's liability-increasing
 *              claim still does park pending.
 *   ISSUE-005  every decision reaches the affected member's BELL, targeted at
 *              that member alone — for corrections (approve AND reject) and for
 *              hosted guests (approve AND reject).
 *
 * Isolation matters as much as delivery: each assertion checks the notice is
 * raised with audience 'members' AND targetUserId set to the one user, which is
 * what stops a decision leaking into another member's feed.
 */

const orgTz = { timezone: 'Asia/Kolkata' };
const todayStr = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
}).format(new Date());

describe('Live-Test-14 — correction decisions notify the member', () => {
  let service: CorrectionsService;
  let repo: any;
  let notices: { createRequestAlert: jest.Mock; createMemberAlert: jest.Mock };
  let notifications: any;
  let prisma: any;
  let attendanceService: any;

  /** A stored request row as the repository would return it. */
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'acr_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    userId: 'usr_member',
    userName: 'Riya',
    mealId: 'meal_01',
    mealName: 'Lunch',
    attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
    createdAt: new Date(),
    requestType: 'claim_present',
    requestedStatus: 'present',
    requestedPreference: null,
    requestedSelections: null,
    status: 'pending',
    sourceChannel: 'member',
    reviewedBy: null,
    reviewNote: null,
    expiresAt: new Date(Date.now() + 3600_000),
    ...over,
  });

  beforeEach(async () => {
    repo = {
      create: jest.fn(async (d: any) => row(d)),
      findById: jest.fn(async () => row()),
      findOpenDuplicate: jest.fn().mockResolvedValue(null),
      countOpenForUser: jest.fn().mockResolvedValue(0),
      countCreatedSince: jest.fn().mockResolvedValue(0),
      expireDue: jest.fn().mockResolvedValue(0),
      updateStatus: jest.fn(async (_id: string, _org: string, d: any) =>
        row({ ...d }),
      ),
    };
    prisma = {
      meal: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'meal_01',
          groupId: 'grp_01',
          price: 50,
          // Closed window: 00:00–00:01 is always in the past, so the
          // "window still open" guard never trips in these tests.
          attendanceWindowOpen: '00:00',
          attendanceWindowClose: '00:01',
          organization: orgTz,
          group: { weeklyMenuEnabled: false, dayWiseMealsEnabled: false },
        }),
      },
      user: {
        // Role is overridden per test — this is the MEMBER default.
        findUnique: jest
          .fn()
          .mockResolvedValue({ role: 'student', isVacationMode: false }),
      },
      // The claim_present vacation gate now runs through
      // getVacationCoveredUserIds (same helper as the attendance-mark and
      // guest-hosting gates), so it is date- AND meal-accurate instead of
      // reading a date-agnostic flag. No approved request here: coverage then
      // falls to the candidate's effective per-group flag, exactly as the
      // "admin on vacation" case below expects.
      vacationRequest: { findMany: jest.fn().mockResolvedValue([]) },
      // The requester's CURRENT role and vacation state now ride the
      // membership point-read: the row carries THIS group's vacation override
      // and the nested user row supplies the role plus the inherited fallback.
      // Default is the pre-migration state — override NULL (inherit).
      groupMember: {
        findUnique: jest.fn().mockResolvedValue({
          isVacationMode: null,
          user: { role: 'student', isVacationMode: false },
        }),
      },
    };
    attendanceService = {
      resolveEffectiveWindow: jest.fn().mockResolvedValue({
        openTime: '00:00',
        closeTime: '00:01',
        price: 50,
        scheduledToday: true,
      }),
      applyConsentedChange: jest.fn().mockResolvedValue({ id: 'att_01' }),
    };
    notices = {
      createRequestAlert: jest.fn().mockResolvedValue(undefined),
      createMemberAlert: jest.fn().mockResolvedValue(undefined),
    };
    notifications = {
      notifyCorrectionRequested: jest.fn().mockResolvedValue(undefined),
      notifyCorrectionDecided: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CorrectionsService,
        { provide: CorrectionRequestsRepository, useValue: repo },
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
        {
          provide: MembersRepository,
          useValue: { isActiveMember: jest.fn().mockResolvedValue(true) },
        },
        { provide: AttendanceService, useValue: attendanceService },
        {
          provide: AttendanceRepository,
          useValue: { findByKey: jest.fn().mockResolvedValue(null) },
        },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: PreferencesService,
          useValue: {
            getEffectiveGroupsForMeal: jest.fn().mockResolvedValue([]),
            applyDayOverride: jest.fn((g: any) => g),
            validateSelections: jest.fn(),
          },
        },
        { provide: NoticesService, useValue: notices },
        {
          provide: 'ATTENDANCE_GATEWAY',
          useValue: { emitToGroup: jest.fn(), emitToUser: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(CorrectionsService);
  });

  const create = (requestType = 'claim_present') =>
    service.createRequest('usr_member', 'org_01', {
      mealId: 'meal_01',
      attendanceDate: todayStr,
      requestType,
    } as any);

  // ── ISSUE-001 ──────────────────────────────────────────────────────────────

  it("a MEMBER's claim_present still parks pending for admin review", async () => {
    const res: any = await create();

    expect(res.status).toBe('pending');
    expect(attendanceService.applyConsentedChange).not.toHaveBeenCalled();
    // The admin queue is alerted, and no decision notice is sent yet.
    expect(notices.createRequestAlert).toHaveBeenCalledTimes(1);
    expect(notices.createMemberAlert).not.toHaveBeenCalled();
  });

  it("an ADMIN's own claim_present is applied immediately, with no review", async () => {
    prisma.groupMember.findUnique.mockResolvedValue({
      isVacationMode: null,
      user: { role: 'messManager', isVacationMode: false },
    });

    const res: any = await create();

    expect(res.status).toBe('approved');
    // The attendance change actually went through the shared consented path.
    expect(attendanceService.applyConsentedChange).toHaveBeenCalledTimes(1);
    // Nothing was ever queued for an admin to review.
    expect(notices.createRequestAlert).not.toHaveBeenCalled();
    // Applied as self-service, not as somebody else's review decision.
    expect(repo.updateStatus).toHaveBeenCalledWith(
      'acr_01',
      'org_01',
      expect.objectContaining({ status: 'approved', reviewedBy: null }),
    );
  });

  it('an admin on vacation still cannot claim Present (guard not bypassed)', async () => {
    // Override NULL -> the user-level flag is inherited, exactly as before
    // the per-group settings existed.
    prisma.groupMember.findUnique.mockResolvedValue({
      isVacationMode: null,
      user: { role: 'messManager', isVacationMode: true },
    });

    await expect(create()).rejects.toThrow(/vacation/i);
    expect(attendanceService.applyConsentedChange).not.toHaveBeenCalled();
  });

  it('a charge dispute is NEVER self-approved, even for an admin', async () => {
    prisma.groupMember.findUnique.mockResolvedValue({
      isVacationMode: null,
      user: { role: 'hostelAdmin', isVacationMode: false },
    });

    const res: any = await create('dispute_charge');

    // Money conversations stay in the ledger workflow.
    expect(res.status).toBe('pending');
    expect(attendanceService.applyConsentedChange).not.toHaveBeenCalled();
  });

  it('self-approval of an own pending request remains forbidden (FR-ACR-010)', async () => {
    repo.findById.mockResolvedValue(row({ userId: 'usr_admin' }));

    await expect(
      service.approve('usr_admin', 'org_01', 'acr_01', {} as any),
    ).rejects.toThrow(/cannot approve your own/i);
  });

  // ── ISSUE-005 ──────────────────────────────────────────────────────────────

  it('APPROVING a correction puts a member-targeted notice in the bell', async () => {
    await service.approve('usr_admin', 'org_01', 'acr_01', {} as any);

    expect(notices.createMemberAlert).toHaveBeenCalledTimes(1);
    const alert = notices.createMemberAlert.mock.calls[0][0];
    expect(alert.targetUserId).toBe('usr_member');
    expect(alert.title).toMatch(/approved/i);
    // Deep-links to the member's own decisions screen.
    expect(alert.linkType).toBe('myCorrections');
    // …and the push channel fires alongside the bell.
    expect(notifications.notifyCorrectionDecided).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_member', approved: true }),
    );
  });

  it('REJECTING a correction also notifies the member', async () => {
    await service.reject('usr_admin', 'org_01', 'acr_01', {} as any);

    expect(notices.createMemberAlert).toHaveBeenCalledTimes(1);
    const alert = notices.createMemberAlert.mock.calls[0][0];
    expect(alert.targetUserId).toBe('usr_member');
    expect(alert.title).toMatch(/rejected/i);
    expect(notifications.notifyCorrectionDecided).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_member', approved: false }),
    );
  });
});

describe('Live-Test-14 ISSUE-005 — guest decisions notify the host', () => {
  let service: GuestsService;
  let notices: { createRequestAlert: jest.Mock; createMemberAlert: jest.Mock };
  let notifications: any;
  let prisma: any;

  const guestRow = {
    id: 'mg_01',
    groupId: 'grp_01',
    hostUserId: 'usr_host',
    createdBy: 'usr_host',
    mealId: 'meal_01',
    attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
    createdAt: new Date(),
    status: 'booked',
    pendingApproval: true,
    isAdult: true,
    priceSnapshot: 60,
    displayName: 'Guest 1',
    mealPreference: null,
    preferences: [],
  };

  beforeEach(async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      mealGuest: {
        update: jest.fn(async () => ({ ...guestRow, pendingApproval: false })),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      attendanceRecord: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      mealGuest: { findFirst: jest.fn().mockResolvedValue(guestRow) },
      meal: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'meal_01',
          name: 'Lunch',
          groupId: 'grp_01',
          price: 60,
          attendanceWindowOpen: null,
          attendanceWindowClose: null,
          group: { enabledPreferences: [], attendanceGraceMinutes: 0 },
          organization: orgTz,
        }),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    notices = {
      createRequestAlert: jest.fn().mockResolvedValue(undefined),
      createMemberAlert: jest.fn().mockResolvedValue(undefined),
    };
    notifications = {
      notifyAttendanceChanged: jest.fn().mockResolvedValue(undefined),
      notifyGuestDecided: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { del: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: MembersRepository,
          useValue: { findMembership: jest.fn() },
        },
        {
          provide: BillingService,
          useValue: {
            isDateFinalized: jest.fn().mockResolvedValue({ locked: false }),
          },
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: NoticesService, useValue: notices },
        {
          provide: 'ATTENDANCE_GATEWAY',
          useValue: {
            emitToGroup: jest.fn(),
            emitToUser: jest.fn(),
            emitToAdmin: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(GuestsService);
  });

  it('APPROVING a guest request notifies the host', async () => {
    await service.approveGuest('usr_admin', 'org_01', 'mg_01', {} as any);

    expect(notices.createMemberAlert).toHaveBeenCalledTimes(1);
    const alert = notices.createMemberAlert.mock.calls[0][0];
    expect(alert.targetUserId).toBe('usr_host');
    expect(alert.title).toMatch(/approved/i);
    // The meal name rides the existing select — never "a meal".
    expect(alert.body).toContain('Lunch');
    expect(notifications.notifyGuestDecided).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_host', approved: true }),
    );
  });

  it('REJECTING a guest request notifies the host', async () => {
    await service.rejectGuest('usr_admin', 'org_01', 'mg_01', {} as any);

    expect(notices.createMemberAlert).toHaveBeenCalledTimes(1);
    const alert = notices.createMemberAlert.mock.calls[0][0];
    expect(alert.targetUserId).toBe('usr_host');
    expect(alert.title).toMatch(/rejected/i);
    expect(notifications.notifyGuestDecided).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_host', approved: false }),
    );
  });

  it('a HOST confirming their own admin-proposed guest is not self-notified', async () => {
    // FR-HG-062: the host IS the actor here, so no "decision" notice is owed.
    prisma.mealGuest.findFirst.mockResolvedValue({
      ...guestRow,
      createdBy: 'usr_admin', // admin-proposed → awaits the host's confirmation
    });

    await service.confirmGuest('usr_host', 'org_01', 'mg_01');

    expect(notices.createMemberAlert).not.toHaveBeenCalled();
    expect(notifications.notifyGuestDecided).not.toHaveBeenCalled();
  });
});
