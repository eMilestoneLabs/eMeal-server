/**
 * attendance-reminder.worker — group-scoped vacation on the reminder push.
 *
 * Vacation is per group (`member ?? user`), so a member on vacation in group A
 * must still be reminded for group B. Getting this wrong is not cosmetic: a
 * dropped reminder means the member never marks, the close sweep neutralizes
 * or auto-marks them per the group policy, and what they are billed changes.
 *
 * The predicate deliberately does NOT live in the SQL where-clause. Expressing
 * it there needs a second reference to the `user` relation next to the one
 * already used for remindersEnabled/fcmToken, and Prisma emits a separate
 * correlated subquery per relation reference — one join on `users` would become
 * two on a hot worker path. A single group's active members is a small set, so
 * the resolve happens in memory and the SQL keeps the exact shape it always
 * had. The final test pins that decision so it cannot silently regress.
 */
import { JOB_TYPES } from '../../queue/constants/queue.constants';
import { AttendanceReminderWorker } from '../attendance-reminder.worker';

describe('AttendanceReminderWorker — per-group vacation', () => {
  let worker: AttendanceReminderWorker;
  let prisma: any;
  let queue: any;

  /** One active member row as the (unchanged) list query returns it. */
  const member = (
    userId: string,
    memberFlag: boolean | null,
    userFlag: boolean,
  ) => ({
    userId,
    isVacationMode: memberFlag,
    user: { fcmToken: `tok-${userId}`, isVacationMode: userFlag },
  });

  const job = {
    id: 'job-1',
    name: JOB_TYPES.DISPATCH_REMINDER,
    data: {
      organizationId: 'org-1',
      groupId: 'grp-1',
      mealId: 'meal-1',
      mealSlotKey: 'lunch',
      minutesBefore: 30,
      dedupKey: 'org-1:meal-1:30min',
    },
  } as any;

  const run = (members: any[]) => {
    prisma.groupMember.findMany.mockResolvedValue(members);
    return worker.process(job);
  };

  /** userIds actually pushed to, or [] when nothing was enqueued. */
  const pushedTo = (): string[] => {
    if (!queue.enqueueBatchPush.mock.calls.length) return [];
    return queue.enqueueBatchPush.mock.calls[0][0].recipients.map(
      (r: any) => r.userId,
    );
  };

  beforeEach(() => {
    prisma = {
      groupMember: { findMany: jest.fn() },
      // Nobody has marked yet, so attendance never masks the vacation result.
      attendanceRecord: { findMany: jest.fn().mockResolvedValue([]) },
      meal: {
        findUnique: jest.fn().mockResolvedValue({
          slotKey: 'lunch',
          attendanceWindowOpen: '12:00',
          organization: { timezone: 'Asia/Kolkata' },
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      group: {
        findUnique: jest.fn().mockResolvedValue({ attendanceDefault: 'absent' }),
      },
      // No published schedule and no approved dated request: the instant
      // per-group setting is the ONLY thing deciding coverage here.
      mealSchedule: { findFirst: jest.fn().mockResolvedValue(null) },
      vacationRequest: { findMany: jest.fn().mockResolvedValue([]) },
    };
    queue = { enqueueBatchPush: jest.fn().mockResolvedValue(undefined) };

    worker = new AttendanceReminderWorker(
      prisma,
      // setDedup true = "not dispatched yet", so the job proceeds.
      { setDedup: jest.fn().mockResolvedValue(true) } as any,
      queue,
      {
        buildAttendanceReminderPayload: jest
          .fn()
          .mockReturnValue({ title: 'Attendance Reminder', body: 'Mark now' }),
      } as any,
    );
  });

  it('BASELINE: a null override inherits the user flag (pre-migration behaviour)', async () => {
    await run([member('u-a', null, false), member('u-b', null, true)]);
    expect(pushedTo()).toEqual(['u-a']);
  });

  // The leak this setting exists to close — and the `??`-vs-`||` regression:
  // an explicit per-group false must beat an inherited true.
  it('still reminds a member who is on vacation in ANOTHER group', async () => {
    await run([member('u-c', false, true)]);
    expect(pushedTo()).toEqual(['u-c']);
  });

  it('suppresses a member on vacation in THIS group, even with the user flag off', async () => {
    await run([member('u-d', true, false)]);
    expect(queue.enqueueBatchPush).not.toHaveBeenCalled();
  });

  it('resolves each member independently within the same group', async () => {
    await run([
      member('u-e', true, false), // per-group ON  → suppressed
      member('u-f', false, true), // per-group OFF → reminded
      member('u-g', null, false), // inherits OFF  → reminded
      member('u-h', null, true), // inherits ON   → suppressed
    ]);
    expect(pushedTo()).toEqual(['u-f', 'u-g']);
  });

  // PLAN-SHAPE GUARD (performance, not correctness): the vacation predicate
  // must stay OUT of the SQL so the where-clause keeps exactly ONE `user`
  // relation reference — i.e. one join on `users`, as before this feature.
  it('keeps the vacation predicate out of the SQL where-clause', async () => {
    await run([]);
    const where = prisma.groupMember.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('OR');
    expect(where).not.toHaveProperty('isVacationMode');
    expect(where.user).not.toHaveProperty('isVacationMode');
    expect(Object.keys(where.user).sort()).toEqual([
      'fcmToken',
      'remindersEnabled',
    ]);
  });
});
