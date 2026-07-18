import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GuestsService } from '../guests.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { AuditService } from '../../../audit/audit.service';
import { BillingService } from '../../billing/billing.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { MembersRepository } from '../../groups/repositories/members.repository';

const todayStr = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
}).format(new Date());

/** Fully-enabled guest group config (cap 5, sameAsMember). */
const baseGroup = {
  id: 'grp_01',
  isActive: true,
  mealsEnabled: true,
  mealPricingEnabled: true,
  preferencesEnabled: true,
  enabledPreferences: ['veg', 'chicken'],
  attendanceGraceMinutes: 0,
  guestAttendanceEnabled: true,
  maxGuestsPerMemberPerMeal: 5,
  maxGuestsPerMemberPerDay: null,
  guestPricingMode: 'sameAsMember',
  guestAdultPrice: null,
  guestChildPrice: null,
  guestSurcharge: null,
  guestRequiresApproval: false,
  guestCutoffMinutesBeforeClose: 0,
  guestAdvanceBookingDays: 0,
  guestPreferenceRequired: false,
  allowGuestWithoutHost: false,
};

const baseMeal = {
  id: 'meal_01',
  name: 'Lunch',
  groupId: 'grp_01',
  price: 60,
  attendanceEnabled: true,
  attendanceWindowOpen: null, // unbounded — no cutoff enforcement
  attendanceWindowClose: null,
  group: baseGroup,
  organization: { timezone: 'Asia/Kolkata' },
};

describe('GuestsService (Module 22)', () => {
  let service: GuestsService;
  let prisma: any;
  let tx: any;
  let membersRepo: { findMembership: jest.Mock };
  let gateway: { emitToGroup: jest.Mock; emitToUser: jest.Mock; emitToAdmin: jest.Mock };

  beforeEach(async () => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      mealGuest: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      attendanceRecord: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      meal: { findFirst: jest.fn().mockResolvedValue(baseMeal) },
      group: { findUnique: jest.fn(), findFirst: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({ isVacationMode: false }),
      },
      attendanceRecord: {
        findFirst: jest.fn().mockResolvedValue({ status: 'present' }),
      },
      // Live-Test-9 ISSUE-003: day resolution reads the published snapshot
      // (mealSchedule) — no published schedule in these tests.
      mealSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
      // Pass 11 (FR-VACX-003): slot-aware vacation coverage — no approved
      // dated requests by default, so the isVacationMode flag governs.
      vacationRequest: { findMany: jest.fn().mockResolvedValue([]) },
      mealGuest: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    membersRepo = {
      findMembership: jest.fn().mockResolvedValue({ status: 'active' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { del: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: MembersRepository, useValue: membersRepo },
        {
          provide: BillingService,
          useValue: {
            isDateFinalized: jest.fn().mockResolvedValue({ locked: false }),
          },
        },
        {
          provide: NotificationsService,
          useValue: { notifyAttendanceChanged: jest.fn() },
        },
        {
          provide: 'ATTENDANCE_GATEWAY',
          useValue: (gateway = {
            emitToGroup: jest.fn(),
            emitToUser: jest.fn(),
            emitToAdmin: jest.fn(),
          }),
        },
      ],
    }).compile();

    service = module.get(GuestsService);
  });

  const book = (guests: any[], hostUserId?: string, role = 'student') =>
    service.bookGuests('usr_host', role, 'org_01', 'meal_01', {
      attendanceDate: todayStr,
      guests,
      hostUserId,
    });

  it('books a guest with the sameAsMember price snapshot (FR-HG-013/051)', async () => {
    await book([{ isAdult: true, mealPreference: 'veg' }]);
    expect(tx.mealGuest.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            hostUserId: 'usr_host',
            isAdult: true,
            mealPreference: 'veg',
            priceSnapshot: 60,
            pendingApproval: false,
            status: 'booked',
          }),
        ],
      }),
    );
    // FR-HG-012: counters recomputed in the SAME transaction.
    expect(tx.attendanceRecord.updateMany).toHaveBeenCalled();
    // FR-HG-063/064 (Pass 9): one versioned realtime event to group + host + admin.
    expect(gateway.emitToGroup).toHaveBeenCalledWith(
      'grp_01',
      'meal.guest.updated.v1',
      expect.objectContaining({ action: 'booked', hostUserId: 'usr_host', count: 1 }),
    );
    expect(gateway.emitToUser).toHaveBeenCalledWith(
      'usr_host', 'meal.guest.updated.v1', expect.anything(),
    );
    expect(gateway.emitToAdmin).toHaveBeenCalledWith(
      'org_01', 'meal.guest.updated.v1', expect.anything(),
    );
  });

  it('prices adult/child via perGuestPrice mode (FR-HG-051)', async () => {
    prisma.meal.findFirst.mockResolvedValue({
      ...baseMeal,
      group: {
        ...baseGroup,
        guestPricingMode: 'perGuestPrice',
        guestAdultPrice: 80,
        guestChildPrice: 40,
      },
    });
    await book([{ isAdult: true }, { isAdult: false }]);
    const rows = tx.mealGuest.createMany.mock.calls[0][0].data;
    expect(rows[0].priceSnapshot).toBe(80);
    expect(rows[1].priceSnapshot).toBe(40);
  });

  it('rejects over-cap bookings with GUEST_LIMIT_REACHED (FR-HG-032/041)', async () => {
    tx.mealGuest.count.mockResolvedValue(5); // cap already reached
    await expect(book([{ isAdult: true }])).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GUEST_LIMIT_REACHED' }),
    });
    expect(tx.mealGuest.createMany).not.toHaveBeenCalled();
  });

  it('requires a preference per guest when configured (FR-HG-031/071)', async () => {
    prisma.meal.findFirst.mockResolvedValue({
      ...baseMeal,
      group: { ...baseGroup, guestPreferenceRequired: true },
    });
    await expect(book([{ isAdult: true }])).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GUEST_PREFERENCE_REQUIRED' }),
    });
  });

  it('blocks same-day booking when the host is not Present (FR-HG-030)', async () => {
    prisma.attendanceRecord.findFirst.mockResolvedValue(null); // unmarked host
    await expect(book([{ isAdult: true }])).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'HOST_NOT_PRESENT' }),
    });
  });

  it('feature gate: disabled group rejects with GUESTS_DISABLED (FR-HG-003)', async () => {
    prisma.meal.findFirst.mockResolvedValue({
      ...baseMeal,
      group: { ...baseGroup, guestAttendanceEnabled: false },
    });
    await expect(book([{ isAdult: true }])).rejects.toThrow(ForbiddenException);
  });

  it('admin-on-behalf bookings park as pendingApproval for HOST consent (FR-HG-062)', async () => {
    await service.bookGuests('adm_01', 'hostelAdmin', 'org_01', 'meal_01', {
      attendanceDate: todayStr,
      guests: [{ isAdult: true }],
      hostUserId: 'usr_host',
    });
    const rows = tx.mealGuest.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({
      hostUserId: 'usr_host',
      createdBy: 'adm_01',
      pendingApproval: true,
    });
  });

  it('vacation hosts cannot host guests (FR-HG-043)', async () => {
    prisma.user.findUnique.mockResolvedValue({ isVacationMode: true });
    await expect(book([{ isAdult: true }])).rejects.toThrow(ForbiddenException);
  });

  it('host-absent reconciliation cancels booked guests (FR-HG-035)', async () => {
    prisma.group.findUnique.mockResolvedValue({
      guestAttendanceEnabled: true,
      allowGuestWithoutHost: false,
    });
    tx.mealGuest.updateMany.mockResolvedValue({ count: 2 });

    const cancelled = await service.reconcileOnHostChange({
      organizationId: 'org_01',
      groupId: 'grp_01',
      hostUserId: 'usr_host',
      mealId: 'meal_01',
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      newStatus: 'absent',
      actorId: 'usr_host',
    });
    expect(cancelled).toBe(2);
    expect(tx.mealGuest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'booked' }),
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
  });

  it('reconciliation is a no-op when hostless guests are allowed', async () => {
    prisma.group.findUnique.mockResolvedValue({
      guestAttendanceEnabled: true,
      allowGuestWithoutHost: true,
    });
    const cancelled = await service.reconcileOnHostChange({
      organizationId: 'org_01',
      groupId: 'grp_01',
      hostUserId: 'usr_host',
      mealId: 'meal_01',
      attendanceDate: new Date(`${todayStr}T00:00:00.000Z`),
      newStatus: 'absent',
      actorId: 'usr_host',
    });
    expect(cancelled).toBe(0);
  });

  it('cancelled/no-show billing follows billNoShowGuests (FR-HG-052 / LOOP-013)', async () => {
    await service.getGuestBillingByHost(
      'org_01', 'grp_01', new Date(), new Date(), false,
    );
    expect(prisma.mealGuest.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['booked'] },
          pendingApproval: false,
        }),
      }),
    );
    await service.getGuestBillingByHost(
      'org_01', 'grp_01', new Date(), new Date(), true,
    );
    expect(prisma.mealGuest.groupBy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['booked', 'no_show'] },
        }),
      }),
    );
  });
});
