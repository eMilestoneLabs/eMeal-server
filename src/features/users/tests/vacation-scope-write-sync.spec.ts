/**
 * A-full at the READ-TIME SYNC (`GET /auth/me`).
 *
 * Pins three things that are invisible until they are already wrong:
 *   • an ORG-LEVEL covering request still raises the ACCOUNT flag (baseline);
 *   • a GROUP-SCOPED one raises ONLY its membership and leaves the account
 *     flag alone — the whole point of A-full;
 *   • the hot path stays clean: an already-activated membership issues NO
 *     write, preserving command_6's "no-flip profile load costs zero queries".
 */
import { UsersRepository } from '../repositories/users.repository';

const TZ = 'Asia/Kolkata';
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

describe('read-time sync — where vacation state is written', () => {
  let prisma: any;
  let repo: UsersRepository;

  beforeEach(() => {
    prisma = {
      user: { update: jest.fn().mockResolvedValue({}) },
      groupMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    repo = new UsersRepository(prisma);
  });

  // A range wide enough to cover "today" in any timezone.
  const covering = (groupId: string | null) => [
    { startDate: day('2000-01-01'), endDate: day('2999-01-01'), groupId },
  ];

  it('BASELINE: an ORG-LEVEL covering request raises the ACCOUNT flag', async () => {
    const out = await repo.resolveVacationFlagPrefetched(
      'u1', false, TZ, covering(null), new Map(),
    );
    expect(out).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { isVacationMode: true },
    });
    expect(prisma.groupMember.updateMany).not.toHaveBeenCalled();
  });

  it('THE FIX: a GROUP-SCOPED request writes the MEMBERSHIP, not the account', async () => {
    const out = await repo.resolveVacationFlagPrefetched(
      'u1', false, TZ, covering('grp_A'), new Map([['grp_A', null]]),
    );
    // The account flag must stay OFF — that is what stops the member being
    // marked on vacation in every other group they belong to.
    expect(out).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();

    const args = prisma.groupMember.updateMany.mock.calls[0][0];
    expect(args.where.userId).toBe('u1');
    expect(args.where.groupId).toEqual({ in: ['grp_A'] });
    // Only rows still INHERITING are touched.
    // "not already true" — idempotent, and still able to re-activate a group
    // the member once returned early from.
    expect(args.where.isVacationMode).toEqual({ not: true });
    expect(args.data).toEqual({ isVacationMode: true });
  });

  it('HOT PATH: an already-activated membership issues NO write', async () => {
    await repo.resolveVacationFlagPrefetched(
      'u1', false, TZ, covering('grp_A'), new Map([['grp_A', true]]),
    );
    expect(prisma.groupMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('REGRESSION: a NEW request re-activates a group returned early from', async () => {
    // Return Early leaves the row at explicit `false`. A LATER approved
    // request for that same group MUST still activate it — the account-flag
    // path has always recovered this way (`covering && !isVacationMode`).
    // Guarding on `null` instead of `not: true` stranded the member
    // off-vacation for every future request in that group.
    await repo.resolveVacationFlagPrefetched(
      'u1', false, TZ, covering('grp_A'), new Map([['grp_A', false]]),
    );
    const args = prisma.groupMember.updateMany.mock.calls[0][0];
    expect(args.where.groupId).toEqual({ in: ['grp_A'] });
    expect(args.where.isVacationMode).toEqual({ not: true });
    expect(args.data).toEqual({ isVacationMode: true });
  });

  it('Return Early stays protected — by its request being ENDED, not the column', async () => {
    // setVacationMode ends the covering request (this group AND org-level),
    // so nothing covers today and nothing re-activates.
    await repo.resolveVacationFlagPrefetched(
      'u1', false, TZ, [], new Map([['grp_A', false]]),
    );
    expect(prisma.groupMember.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a group-scoped request that ENDED restores NULL (inherit), not false', async () => {
    const ended = [
      { startDate: day('2000-01-01'), endDate: day('2000-01-02'), groupId: 'grp_A' },
    ];
    await repo.resolveVacationFlagPrefetched(
      'u1', false, TZ, ended, new Map([['grp_A', true]]),
    );
    const args = prisma.groupMember.updateMany.mock.calls[0][0];
    expect(args.where.isVacationMode).toBe(true);
    // NULL restores inheritance; `false` would permanently shadow any later
    // org-wide vacation for this group.
    expect(args.data).toEqual({ isVacationMode: null });
  });

  it('THE SPILL VIA RESUME: an expired ORG-LEVEL flag clears even while group leave is live', async () => {
    // Org-level ended yesterday; group-A leave covers today. Legal — the
    // FR-VACX-001 overlap guard only forbids OVERLAPPING ranges.
    // Counting the group-A request as "covering" left the ACCOUNT flag true,
    // claiming ORG-WIDE vacation in every other group.
    const mixed = [
      { startDate: day('2000-01-01'), endDate: day('2000-01-02'), groupId: null },
      { startDate: day('2000-01-01'), endDate: day('2999-01-01'), groupId: 'grp_A' },
    ];
    const out = await repo.resolveVacationFlagPrefetched(
      'u1', true, TZ, mixed, new Map([['grp_A', true]]),
    );
    expect(out).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { isVacationMode: false },
    });
  });

  it('a LIVE org-level vacation is never resumed (baseline preserved)', async () => {
    await repo.resolveVacationFlagPrefetched(
      'u1', true, TZ, covering(null), new Map(),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a GROUP-scoped request alone never clears the account flag by itself', async () => {
    // No org-level request has ever ended, so the flag is toggle-driven and
    // must survive (LT-8 ISSUE-007).
    await repo.resolveVacationFlagPrefetched(
      'u1', true, TZ, covering('grp_A'), new Map([['grp_A', true]]),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('COMPATIBILITY: with no membership context the org-level rules are unchanged', async () => {
    const out = await repo.resolveVacationFlagPrefetched(
      'u1', false, TZ, covering(null),
    );
    expect(out).toBe(true);
    expect(prisma.groupMember.updateMany).not.toHaveBeenCalled();
  });
});
