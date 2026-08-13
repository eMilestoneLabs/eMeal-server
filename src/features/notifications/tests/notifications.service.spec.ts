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
import { NotificationSendService } from '../services/notification-send.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    update: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
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

// FR-NOTX-018 diagnostics reads the channel state; delivery itself is mocked.
const mockSendService = {
  pushEnabled: true,
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
        { provide: NotificationSendService, useValue: mockSendService },
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

  it('scheduleAttendanceReminders enqueues 30min and 10min reminders when window is far enough', async () => {
    // GAP-NOT-1 (RESOLVED): source-of-truth offsets are 30/10 min before close
    const windowCloseAt = new Date(Date.now() + 90 * 60 * 1000); // 90 min from now

    await service.scheduleAttendanceReminders({
      organizationId: 'org-1',
      groupId: 'group-1',
      mealId: 'meal-1',
      mealSlotKey: 'lunch',
      windowCloseAt,
    });

    // Both 30-min and 10-min reminders should be enqueued
    expect(mockQueue.scheduleAttendanceReminder).toHaveBeenCalledTimes(2);

    const calls = mockQueue.scheduleAttendanceReminder.mock.calls;
    const minutesBefore = calls.map((c: any[]) => c[0].minutesBefore);
    expect(minutesBefore).toContain(30);
    expect(minutesBefore).toContain(10);
  });

  it('scheduleAttendanceReminders enqueues only the 10min reminder when window is 25 min away', async () => {
    const windowCloseAt = new Date(Date.now() + 25 * 60 * 1000); // 25 min from now

    await service.scheduleAttendanceReminders({
      organizationId: 'org-1',
      groupId: 'group-1',
      mealId: 'meal-1',
      mealSlotKey: 'breakfast',
      windowCloseAt,
    });

    expect(mockQueue.scheduleAttendanceReminder).toHaveBeenCalledTimes(1);
    expect(mockQueue.scheduleAttendanceReminder.mock.calls[0][0].minutesBefore).toBe(10);
  });

  it('scheduleAttendanceReminders enqueues nothing when window is less than 15 min away', async () => {
    const windowCloseAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min from now

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

  // ── Notice published push (FR-NOTX-006 / ISSUE-15) ──────────────────────────

  it('notifyNoticePublished enqueues a batch push to org members with devices', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'user-1', fcmToken: 'tok-1' },
      { id: 'user-2', fcmToken: 'tok-2' },
    ]);

    await service.notifyNoticePublished({
      organizationId: 'org-1',
      groupId: null, // org-wide
      noticeId: 'notice-1',
      title: 'Mess closed Sunday',
      priority: 'urgent',
    });

    expect(mockQueue.enqueueBatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        recipients: [
          { userId: 'user-1', fcmToken: 'tok-1' },
          { userId: 'user-2', fcmToken: 'tok-2' },
        ],
        route: '/student/dashboard',
      }),
    );
  });

  it('notifyNoticePublished scopes to group members for group notices', async () => {
    mockPrisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: 'user-3', user: { fcmToken: 'tok-3' } },
    ]);

    await service.notifyNoticePublished({
      organizationId: 'org-1',
      groupId: 'group-1',
      noticeId: 'notice-2',
      title: 'Dinner delayed',
      priority: 'normal',
    });

    expect(mockPrisma.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ groupId: 'group-1', status: 'active' }),
      }),
    );
    expect(mockQueue.enqueueBatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [{ userId: 'user-3', fcmToken: 'tok-3' }],
      }),
    );
  });

  // ── Group-scoped vacation on the schedule-published push ────────────────
  //
  // Vacation is per group (`member ?? user`). The SQL filter deliberately does
  // NOT express it — adding it would need a second reference to the `user`
  // relation next to the reminders/token one, and Prisma emits a separate
  // correlated subquery per relation reference, turning one join on `users`
  // into two. The resolve therefore happens in memory, and these tests are
  // what keep that decision honest.

  it('notifySchedulePublished inherits the user flag when the group has no override', async () => {
    mockPrisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: 'u-a', isVacationMode: null, user: { fcmToken: 'tok-a', isVacationMode: false } },
      { userId: 'u-b', isVacationMode: null, user: { fcmToken: 'tok-b', isVacationMode: true } },
    ]);

    await service.notifySchedulePublished({
      organizationId: 'org-1',
      groupId: 'group-1',
      weekStartDate: '2026-08-10',
    });

    expect(mockQueue.enqueueBatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [{ userId: 'u-a', fcmToken: 'tok-a' }],
      }),
    );
  });

  it('notifySchedulePublished still pushes to a member on vacation in ANOTHER group', async () => {
    mockPrisma.groupMember.findMany.mockResolvedValueOnce([
      // Per-group false must beat the inherited true — this is the leak the
      // per-group setting exists to close, and the `??`-vs-`||` regression.
      { userId: 'u-c', isVacationMode: false, user: { fcmToken: 'tok-c', isVacationMode: true } },
    ]);

    await service.notifySchedulePublished({
      organizationId: 'org-1',
      groupId: 'group-1',
      weekStartDate: '2026-08-10',
    });

    expect(mockQueue.enqueueBatchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [{ userId: 'u-c', fcmToken: 'tok-c' }],
      }),
    );
  });

  it('notifySchedulePublished suppresses a member on vacation in THIS group', async () => {
    mockPrisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: 'u-d', isVacationMode: true, user: { fcmToken: 'tok-d', isVacationMode: false } },
    ]);

    await service.notifySchedulePublished({
      organizationId: 'org-1',
      groupId: 'group-1',
      weekStartDate: '2026-08-10',
    });

    expect(mockQueue.enqueueBatchPush).not.toHaveBeenCalled();
  });

  // Plan-shape guard: the vacation predicate must stay OUT of the SQL, so the
  // where-clause keeps exactly ONE `user` relation reference (one join).
  it('notifySchedulePublished keeps the vacation filter out of the SQL where-clause', async () => {
    mockPrisma.groupMember.findMany.mockResolvedValueOnce([]);

    await service.notifySchedulePublished({
      organizationId: 'org-1',
      groupId: 'group-1',
      weekStartDate: '2026-08-10',
    });

    const where = mockPrisma.groupMember.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('OR');
    expect(where).not.toHaveProperty('isVacationMode');
    expect(where.user).not.toHaveProperty('isVacationMode');
    expect(Object.keys(where.user).sort()).toEqual(['fcmToken', 'remindersEnabled']);
  });

  it('notifyNoticePublished never throws when push enqueue fails (FR-NOTX-016)', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'user-1', fcmToken: 'tok-1' },
    ]);
    mockQueue.enqueueBatchPush.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.notifyNoticePublished({
        organizationId: 'org-1',
        groupId: null,
        noticeId: 'notice-3',
        title: 'Test',
        priority: 'normal',
      }),
    ).resolves.toBeUndefined();
  });

  // ── Delivery diagnostics (FR-NOTX-018 / ISSUE-16) ────────────────────────────

  it('getDiagnostics reports channel state, device counts, and last send', async () => {
    mockPrisma.user.count
      .mockResolvedValueOnce(8) // registered devices
      .mockResolvedValueOnce(10); // total members
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({
        at: '2026-07-03T10:00:00.000Z',
        title: 'Mess closed Sunday',
        successful: 7,
        failed: 1,
        total: 8,
      }),
    );

    const result = await service.getDiagnostics('org-1');

    expect(result).toEqual(
      expect.objectContaining({
        pushConfigured: true,
        registeredDevices: 8,
        membersWithoutDevice: 2,
        totalMembers: 10,
        lastSend: expect.objectContaining({ successful: 7, failed: 1 }),
      }),
    );
  });

  it('getDiagnostics degrades gracefully when Redis last-send read fails', async () => {
    mockPrisma.user.count.mockResolvedValueOnce(3).mockResolvedValueOnce(5);
    mockRedis.get.mockRejectedValueOnce(new Error('redis down'));

    const result = await service.getDiagnostics('org-1');

    expect(result).toEqual(
      expect.objectContaining({ registeredDevices: 3, lastSend: null }),
    );
  });
});
