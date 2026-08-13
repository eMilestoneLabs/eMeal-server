/**
 * FR-VACX-006 sweep — the ACCOUNT flag and the MEMBERSHIP rows are resumed by
 * DIFFERENT requests, and mixing them re-creates the cross-group spill.
 *
 * `User.isVacationMode` means ORG-WIDE leave (A-full). So the account-flag
 * resume must consider ORG-LEVEL requests only: a group-scoped request owns
 * its own membership row. Building `coveredNow` from every request meant an
 * EXPIRED org-level vacation stayed switched on just because an unrelated
 * group's vacation had started — spilling org-wide vacation into every group.
 *
 * Drives the real `vacationSweep` through a mocked Prisma; the assertions are
 * the actual writes it issues.
 */
import { SystemDefaultWorker } from '../system-default.worker';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('vacationSweep — account flag vs membership scope', () => {
  const build = (requests: any[], flagged: any[], flaggedMembers: any[] = []) => {
    const userUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const memberUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: any = {
      user: { findMany: jest.fn().mockResolvedValue(flagged), updateMany: userUpdateMany },
      vacationRequest: { findMany: jest.fn().mockResolvedValue(requests) },
      organization: {
        findMany: jest.fn().mockResolvedValue([{ id: 'org1', timezone: 'UTC' }]),
      },
      groupMember: {
        // Membership counterpart of `flaggedUsers`: the in-memory guard that
        // stops the sweep writing when nothing changed.
        findMany: jest.fn().mockResolvedValue(flaggedMembers),
        updateMany: memberUpdateMany,
      },
    };
    const worker = new SystemDefaultWorker(
      prisma,
      {} as any,
      {} as any,
      { log: jest.fn() } as any,
      { get: () => undefined } as any,
    );
    return { worker, userUpdateMany, memberUpdateMany };
  };

  const TODAY = new Date();
  const iso = (offsetDays: number) => {
    const x = new Date(TODAY);
    x.setUTCDate(x.getUTCDate() + offsetDays);
    return d(x.toISOString().slice(0, 10));
  };

  const req = (groupId: string | null, from: number, to: number) => ({
    userId: 'u1',
    organizationId: 'org1',
    groupId,
    startDate: iso(from),
    endDate: iso(to),
  });

  it('THE SPILL VIA RESUME: an expired ORG-LEVEL vacation resumes even while a group vacation is live', async () => {
    // Org-level ended yesterday; group-A leave started today. Legal — the
    // FR-VACX-001 overlap guard only forbids OVERLAPPING ranges.
    const { worker, userUpdateMany } = build(
      [req(null, -2, -1), req('grp_A', 0, 2)],
      [{ id: 'u1', organizationId: 'org1' }],
    );
    await (worker as any).vacationSweep();

    // The account flag MUST clear. Counting the group-A request as "covered
    // now" left it true, claiming org-wide vacation in every other group.
    const cleared = userUpdateMany.mock.calls.find(
      (c) => c[0].data?.isVacationMode === false,
    );
    expect(cleared).toBeDefined();
    expect(cleared![0].where.id).toEqual({ in: ['u1'] });
  });

  it('a live ORG-LEVEL vacation is NOT resumed (baseline preserved)', async () => {
    const { worker, userUpdateMany } = build(
      [req(null, -1, 2)],
      [{ id: 'u1', organizationId: 'org1' }],
    );
    await (worker as any).vacationSweep();
    expect(
      userUpdateMany.mock.calls.find((c) => c[0].data?.isVacationMode === false),
    ).toBeUndefined();
  });

  it('a GROUP-SCOPED request activates its MEMBERSHIP, never the account flag', async () => {
    const { worker, userUpdateMany, memberUpdateMany } = build(
      [req('grp_A', 0, 2)],
      [],
    );
    await (worker as any).vacationSweep();

    const activated = memberUpdateMany.mock.calls.find(
      (c) => c[0].data?.isVacationMode === true,
    );
    expect(activated).toBeDefined();
    expect(activated![0].where.groupId).toBe('grp_A');
    // `not: true` keeps it idempotent AND lets a group returned early from be
    // re-activated by a new request.
    expect(activated![0].where.isVacationMode).toEqual({ not: true });
    // The account flag must not be raised by group-scoped leave.
    expect(
      userUpdateMany.mock.calls.find((c) => c[0].data?.isVacationMode === true),
    ).toBeUndefined();
  });

  it('an ENDED group-scoped request restores its membership to NULL (inherit)', async () => {
    const { worker, memberUpdateMany } = build(
      [req('grp_A', -2, -1)],
      [],
      [{ userId: 'u1', groupId: 'grp_A' }], // membership currently ON
    );
    await (worker as any).vacationSweep();

    const resumed = memberUpdateMany.mock.calls.find(
      (c) => c[0].data?.isVacationMode === null,
    );
    expect(resumed).toBeDefined();
    expect(resumed![0].where.groupId).toBe('grp_A');
    // Only rows a request actually activated.
    expect(resumed![0].where.isVacationMode).toBe(true);
  });

  it('COST GUARD: an already-active membership issues NO write', async () => {
    // Parity with `flaggedSet` on the account flag. Without this the sweep
    // fired a no-op updateMany per group on EVERY tick, scaling with group
    // count for zero effect.
    const { worker, memberUpdateMany } = build(
      [req('grp_A', 0, 2)],
      [],
      [{ userId: 'u1', groupId: 'grp_A' }],
    );
    await (worker as any).vacationSweep();
    expect(
      memberUpdateMany.mock.calls.find((c) => c[0].data?.isVacationMode === true),
    ).toBeUndefined();
  });

  it('an ended request for a NEVER-activated group writes nothing', async () => {
    const { worker, memberUpdateMany } = build([req('grp_A', -2, -1)], [], []);
    await (worker as any).vacationSweep();
    expect(
      memberUpdateMany.mock.calls.find((c) => c[0].data?.isVacationMode === null),
    ).toBeUndefined();
  });
});
