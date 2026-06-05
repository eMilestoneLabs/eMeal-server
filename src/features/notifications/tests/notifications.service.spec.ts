/**
 * notifications.service.spec.ts — B6 Phase
 *
 * Unit tests for NotificationsService.
 * Verifies: FCM token deduplication, revocation, reminder scheduling guards.
 * Does NOT test actual FCM delivery (NotificationSendService is mocked).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from '../notifications.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { QueueService } from '../../../queue/queue.service';
import { NotificationPayloadService } from '../services/notification-payload.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    update: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  groupMember: { findMany: jest.fn() },
  attendanceRecord: { findMany: jest.fn() },
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  setDedup: jest.fn(),
};

const mockQueue = {
  scheduleAttendanceReminder: jest.fn().mockResolvedValue('job-id-1'),
  enqueueBatchPush: jest.fn().mockResolvedValue('job-id-2'),
  enqueuePush: jest.fn().mockResolvedValue('job-id-3'),
};

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        NotificationPayloadService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: QueueService, useValue: mockQueue },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    jest.clearAllMocks();
  });

  // ── FCM token registration ─────────────────────────────────────────────────

  it('registerFcmToken skips DB write when token unchanged (dedup)', async () => {
    mockRedis.get.mockResolvedValueOnce('existing-token-123');

    const result = await service.registerFcmToken('user-1', 'existing-token-123');

    expect(result.registered).toBe(false);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('registerFcmToken writes to DB when token has changed', async () => {
    mockRedis.get.mockResolvedValueOnce('old-token');
    mockPrisma.user.update.mockResolvedValueOnce({ id: 'user-1' });
    mockRedis.set.mockResolvedValueOnce('OK');

    const result = await service.registerFcmToken('user-1', 'new-token-456');

    expect(result.registered).toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: { fcmToken: 'new-token-456' },
      }),
    );
  });

  it('registerFcmToken writes to DB when no token cached yet', async () => {
    mockRedis.get.mockResolvedValueOnce(null); // no cached token
    mockPrisma.user.update.mockResolvedValueOnce({ id: 'user-1' });
    mockRedis.set.mockResolvedValueOnce('OK');

    const result = await service.registerFcmToken('user-1', 'brand-new-token');

    expect(result.registered).toBe(true);
  });

  // ── FCM token revocation ────────────────────────────────────────────────────

  it('revokeFcmToken clears DB token and Redis cache', async () => {
    mockPrisma.user.update.mockResolvedValueOnce({ id: 'user-1' });
    mockRedis.del.mockResolvedValueOnce(1);

    await service.revokeFcmToken('user-1');

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: { fcmToken: null },
      }),
    );
    expect(mockRedis.del).toHaveBeenCalledWith('fcm:token:user-1');
  });

  // ── Attendance reminder scheduling ─────────────────────────────────────────

  it('scheduleAttendanceReminders enqueues 60min and 30min reminders when window is far enough', async () => {
    const windowCloseAt = new Date(Date.now() + 90 * 60 * 1000); // 90 min from now

    await service.scheduleAttendanceReminders({
      organizationId: 'org-1',
      groupId: 'group-1',
      mealId: 'meal-1',
      mealSlotKey: 'lunch',
      windowCloseAt,
    });

    // Both 60-min and 30-min reminders should be enqueued
    expect(mockQueue.scheduleAttendanceReminder).toHaveBeenCalledTimes(2);

    const calls = mockQueue.scheduleAttendanceReminder.mock.calls;
    const minutesBefore = calls.map((c: any[]) => c[0].minutesBefore);
    expect(minutesBefore).toContain(60);
    expect(minutesBefore).toContain(30);
  });

  it('scheduleAttendanceReminders enqueues only 30min reminder when window is 40 min away', async () => {
    const windowCloseAt = new Date(Date.now() + 40 * 60 * 1000); // 40 min from now

    await service.scheduleAttendanceReminders({
      organizationId: 'org-1',
      groupId: 'group-1',
      mealId: 'meal-1',
      mealSlotKey: 'breakfast',
      windowCloseAt,
    });

    expect(mockQueue.scheduleAttendanceReminder).toHaveBeenCalledTimes(1);
    expect(mockQueue.scheduleAttendanceReminder.mock.calls[0][0].minutesBefore).toBe(30);
  });

  it('scheduleAttendanceReminders enqueues nothing when window is less than 35 min away', async () => {
    const windowCloseAt = new Date(Date.now() + 20 * 60 * 1000); // 20 min from now

    await service.scheduleAttendanceReminders({
      organizationId: 'org-1',
      groupId: 'group-1',
      mealId: 'meal-1',
      mealSlotKey: 'dinner',
      windowCloseAt,
    });

    expect(mockQueue.scheduleAttendanceReminder).not.toHaveBeenCalled();
  });

  // ── Group membership notification ──────────────────────────────────────────

  it('notifyGroupMembership skips users with remindersEnabled=false', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      fcmToken: 'some-token',
      remindersEnabled: false,
      isVacationMode: false,
    });

    await service.notifyGroupMembership({
      organizationId: 'org-1',
      userId: 'user-1',
      groupName: 'Block A',
      action: 'joined',
    });

    expect(mockQueue.enqueuePush).not.toHaveBeenCalled();
  });

  it('notifyGroupMembership skips users on vacation mode', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      fcmToken: 'some-token',
      remindersEnabled: true,
      isVacationMode: true,
    });

    await service.notifyGroupMembership({
      organizationId: 'org-1',
      userId: 'user-1',
      groupName: 'Block A',
      action: 'joined',
    });

    expect(mockQueue.enqueuePush).not.toHaveBeenCalled();
  });

  it('notifyGroupMembership enqueues push for eligible user', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      fcmToken: 'valid-token-xyz',
      remindersEnabled: true,
      isVacationMode: false,
    });

    await service.notifyGroupMembership({
      organizationId: 'org-1',
      userId: 'user-1',
      groupName: 'Block A',
      action: 'joined',
    });

    expect(mockQueue.enqueuePush).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        fcmToken: 'valid-token-xyz',
        route: '/student/dashboard',
      }),
    );
  });
});
