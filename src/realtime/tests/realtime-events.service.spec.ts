import { RealtimeEventsService } from '../services/realtime-events.service';

/**
 * Live-Test-17 JOIN-01 — membership events must also reach the AFFECTED user.
 *
 * A member whose join was just approved is by definition NOT in
 * `group:{groupId}`: `AttendanceGateway.handleJoinGroup` requires an ACTIVE
 * membership, which is exactly what the event announces. Emitting only to the
 * group room means the one person who most needs the transition is the only one
 * who never receives it.
 *
 * These specs also PIN the blast radius: every OTHER emitter must keep its
 * original room set, so the fix cannot silently widen unrelated broadcasts.
 */
describe('RealtimeEventsService — membership event routing (JOIN-01)', () => {
  function makeService() {
    const gateway = {
      emitToGroup: jest.fn(),
      emitToUser: jest.fn(),
      emitToOrg: jest.fn(),
      emitToAdmin: jest.fn(),
    };
    // The service takes the gateway via @Optional() @Inject('ATTENDANCE_GATEWAY').
    const service = new RealtimeEventsService(gateway as any);
    return { service, gateway };
  }

  const payload = {
    groupId: 'grp_01',
    userId: 'usr_student',
    action: 'joined' as const,
  };

  // ── POSITIVE ──────────────────────────────────────────────────────────────

  it('POSITIVE: an approved join reaches BOTH the group room and the member', () => {
    const { service, gateway } = makeService();

    service.emitGroupMemberUpdated('grp_01', payload);

    expect(gateway.emitToGroup).toHaveBeenCalledWith(
      'grp_01',
      'group.member.updated.v1',
      payload,
    );
    expect(gateway.emitToUser).toHaveBeenCalledWith(
      'usr_student',
      'group.member.updated.v1',
      payload,
    );
  });

  it('POSITIVE: both rooms receive the IDENTICAL payload object', () => {
    // A divergent payload would make the two deliveries disagree; the client
    // filters on `action` + `userId`, so both must carry them unchanged.
    const { service, gateway } = makeService();

    service.emitGroupMemberUpdated('grp_01', payload);

    expect(gateway.emitToGroup.mock.calls[0][2]).toBe(
      gateway.emitToUser.mock.calls[0][2],
    );
  });

  // ── NEGATIVE ──────────────────────────────────────────────────────────────

  it('NEGATIVE: no gateway (degraded env / unit tests) is a silent no-op', () => {
    // Every emitter is @Optional() so the API keeps working when realtime is
    // not wired. This must NOT throw.
    const service = new RealtimeEventsService(null as any);

    expect(() =>
      service.emitGroupMemberUpdated('grp_01', payload),
    ).not.toThrow();
  });

  // ── CORNER ────────────────────────────────────────────────────────────────

  it('CORNER: every action type routes to both rooms, not just "joined"', () => {
    // The client filters by action; routing must stay uniform so a future
    // consumer of removed/blocked is not silently starved.
    const actions = [
      'joined',
      'left',
      'removed',
      'blocked',
      'unblocked',
      'role_changed',
    ] as const;

    for (const action of actions) {
      const { service, gateway } = makeService();
      service.emitGroupMemberUpdated('grp_01', { ...payload, action });
      expect(gateway.emitToGroup).toHaveBeenCalledTimes(1);
      expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
    }
  });

  it('CORNER: the pattern mirrored from emitMemberBlocked is unchanged', () => {
    // Regression pin on the precedent this fix copied.
    const { service, gateway } = makeService();

    service.emitMemberBlocked('grp_01', {
      groupId: 'grp_01',
      userId: 'usr_student',
      blockedBy: 'usr_admin',
    });

    expect(gateway.emitToGroup).toHaveBeenCalledTimes(1);
    expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
  });

  // ── BLAST-RADIUS PIN: unrelated emitters must NOT have been widened ───────

  it('BLAST RADIUS: attendance events still go to the group room ONLY', () => {
    const { service, gateway } = makeService();

    service.emitAttendanceMarked('grp_01', {
      groupId: 'grp_01',
      userId: 'usr_student',
      mealId: 'meal_01',
      date: '2026-08-05',
      status: 'present',
      preference: null,
      markedAt: new Date().toISOString(),
    });

    expect(gateway.emitToGroup).toHaveBeenCalledTimes(1);
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });

  it('BLAST RADIUS: group-config events still go to the group room ONLY', () => {
    const { service, gateway } = makeService();

    service.emitGroupConfigUpdated('grp_01', {
      groupId: 'grp_01',
      changes: { mealsEnabled: false },
    });

    expect(gateway.emitToGroup).toHaveBeenCalledTimes(1);
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });
});
