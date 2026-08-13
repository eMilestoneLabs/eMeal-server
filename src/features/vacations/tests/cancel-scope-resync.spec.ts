/**
 * Cancel path — the "still covered?" check must ask about the SAME state the
 * write then resyncs.
 *
 * A-full made the write group-scoped (a group-scoped request owns
 * `GroupMember.isVacationMode`; an org-level one owns `User.isVacationMode`).
 * The check stayed user-level, so cancelling a group-A vacation while an
 * unrelated group-B vacation was live answered "still covered" and left group
 * A's membership switched ON after its leave had been cancelled.
 */
import { VacationRequestsRepository } from '../repositories/vacation-requests.repository';

describe('hasApprovedCovering — scope matches the write', () => {
  let prisma: any;
  let repo: VacationRequestsRepository;
  const TODAY = new Date('2026-08-13T00:00:00.000Z');

  beforeEach(() => {
    prisma = { vacationRequest: { findFirst: jest.fn().mockResolvedValue(null) } };
    repo = new VacationRequestsRepository(prisma);
  });

  const whereOf = () => prisma.vacationRequest.findFirst.mock.calls[0][0].where;

  it('COMPATIBILITY: unscoped call keeps the historical user-level check', async () => {
    await repo.hasApprovedCovering('u1', 'org1', TODAY, 'req_1');
    const w = whereOf();
    expect(w.userId).toBe('u1');
    expect(w.organizationId).toBe('org1');
    expect(w.id).toEqual({ not: 'req_1' });
    // No group narrowing at all — byte-identical to before A-full.
    expect(w.OR).toBeUndefined();
    expect(w.groupId).toBeUndefined();
  });

  it('GROUP-SCOPED cancel asks only about THAT group (plus org-level)', async () => {
    await repo.hasApprovedCovering('u1', 'org1', TODAY, 'req_A', 'grp_A', true);
    // An unrelated group-B vacation must NOT keep group A switched on.
    expect(whereOf().OR).toEqual([{ groupId: 'grp_A' }, { groupId: null }]);
  });

  it('an ORG-LEVEL request still counts as covering a group-scoped cancel', async () => {
    // It genuinely governs every group, so it legitimately holds A open.
    await repo.hasApprovedCovering('u1', 'org1', TODAY, 'req_A', 'grp_A', true);
    expect(whereOf().OR).toContainEqual({ groupId: null });
  });

  it('ORG-LEVEL cancel asks ONLY about other org-level requests', async () => {
    // A group-scoped request owns its own membership row; it must never hold
    // the ACCOUNT flag up after the org-wide leave is cancelled.
    await repo.hasApprovedCovering('u1', 'org1', TODAY, 'req_org', null, true);
    expect(whereOf().groupId).toBeNull();
    expect(whereOf().OR).toBeUndefined();
  });

  it('tenant + user isolation is preserved on every variant', async () => {
    for (const scope of [undefined, 'grp_A', null] as const) {
      prisma.vacationRequest.findFirst.mockClear();
      await repo.hasApprovedCovering('u1', 'org1', TODAY, 'x', scope, scope !== undefined);
      const w = prisma.vacationRequest.findFirst.mock.calls[0][0].where;
      expect(w.organizationId).toBe('org1');
      expect(w.userId).toBe('u1');
      expect(w.status).toBe('approved');
      expect(w.deletedAt).toBeNull();
    }
  });
});

// ── ORG-WIDE activation must not be shadowed by a per-group override ────────
describe('setUserVacation — org-wide governs every group', () => {
  let prisma: any;
  let repo: VacationRequestsRepository;

  beforeEach(() => {
    prisma = {
      user: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      groupMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn().mockResolvedValue([{}, {}]),
    };
    repo = new VacationRequestsRepository(prisma);
  });

  it('CORNER: activating ORG-WIDE leave clears a stale per-group override', async () => {
    // Member returned early from group A once, leaving an explicit `false`.
    // `member ?? user` would keep them OFF-leave there for the entire org-wide
    // vacation — wrong in the roster badge, the client and the stored state.
    await repo.setUserVacation('u1', 'org1', true, null);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const cleared = prisma.groupMember.updateMany.mock.calls[0][0];
    expect(cleared.where.userId).toBe('u1');
    // NULL restores inheritance — `false` would shadow it all over again.
    expect(cleared.data).toEqual({ isVacationMode: null });
    // Only rows that actually carry an override.
    expect(cleared.where.isVacationMode).toEqual({ not: null });
    // Tenant isolation on the clear.
    expect(cleared.where.group).toEqual({ organizationId: 'org1' });
  });

  it('DEACTIVATION does NOT clear — a per-group leave set during it survives', async () => {
    await repo.setUserVacation('u1', 'org1', false, null);
    expect(prisma.groupMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', organizationId: 'org1' },
      data: { isVacationMode: false },
    });
  });

  it('GROUP-SCOPED activation never touches the account flag or other groups', async () => {
    await repo.setUserVacation('u1', 'org1', true, 'grp_A');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    const w = prisma.groupMember.updateMany.mock.calls[0][0];
    expect(w.where.groupId).toBe('grp_A');
    expect(w.where.group).toEqual({ organizationId: 'org1' });
    expect(w.data).toEqual({ isVacationMode: true });
  });
});
