/**
 * Query-shape guards for the group-scoped member-settings repository methods.
 *
 * The service-level specs mock the repository, so they cannot see the WHERE
 * clauses these methods build — and those clauses carry two guarantees that
 * are invisible in behaviour until they are already wrong:
 *
 *   • TENANT ISOLATION — a client-supplied groupId is only ever resolved
 *     through `group: { organizationId }` and `status: 'active'`. Without that
 *     relation filter, any caller could name another organization's group id.
 *   • RETURN-EARLY SCOPE — with a groupId, only that group's requests (plus
 *     org-level ones, which genuinely cover it) may be ended; without one, the
 *     historical behaviour of ending every covering request must survive
 *     untouched, because that is what the org-wide toggle still means.
 *
 * Both are asserted against the arguments actually handed to Prisma.
 */
import { UsersRepository } from '../repositories/users.repository';

describe('member-settings repository query shapes', () => {
  let prisma: any;
  let repo: UsersRepository;

  beforeEach(() => {
    prisma = {
      groupMember: {
        findFirst: jest.fn().mockResolvedValue({ id: 'gm_1' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ organization: { timezone: 'Asia/Kolkata' } }),
      },
      vacationRequest: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    repo = new UsersRepository(prisma);
  });

  describe('findActiveMembershipId — tenant isolation', () => {
    it('scopes by user, group, ACTIVE status AND the organization relation', async () => {
      await repo.findActiveMembershipId('u1', 'grp_A', 'org1');
      const where = prisma.groupMember.findFirst.mock.calls[0][0].where;
      expect(where.userId).toBe('u1');
      expect(where.groupId).toBe('grp_A');
      expect(where.status).toBe('active');
      // The isolation guarantee — dropping this lets a caller name another
      // tenant's group id and have it resolve. `isActive` is the archived-group
      // re-check: an archived group must not accept a setting that would
      // silently take effect if the group is ever restored.
      expect(where.group).toEqual({ organizationId: 'org1', isActive: true });
    });

    it('returns null when nothing matches, so callers reject rather than write', async () => {
      prisma.groupMember.findFirst.mockResolvedValue(null);
      await expect(
        repo.findActiveMembershipId('u1', 'grp_X', 'org1'),
      ).resolves.toBeNull();
    });

    it('is a single indexed point read — no extra query', async () => {
      await repo.findActiveMembershipId('u1', 'grp_A', 'org1');
      expect(prisma.groupMember.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  // The two per-group writers validate AND write in ONE statement: the
  // where-clause carries the membership, the ACTIVE status and the
  // organization relation, so a foreign / inactive / concurrently-removed
  // membership matches nothing instead of racing a separate pre-check (and
  // instead of raising Prisma P2025, which the global filter does not map).
  // Every clause below is load-bearing security — assert them explicitly.
  describe('per-group writers — atomic validate + write', () => {
    const cases: Array<[string, () => Promise<boolean>, string]> = [
      [
        'setMemberDefaultAttendance',
        () => repo.setMemberDefaultAttendance('u1', 'grp_A', 'org1', true),
        'isDefaultAttendance',
      ],
      [
        'setMemberVacationMode',
        () => repo.setMemberVacationMode('u1', 'grp_A', 'org1', true),
        'isVacationMode',
      ],
    ];

    for (const [name, call, field] of cases) {
      it(`${name} scopes the WRITE by user, group, ACTIVE status and organization`, async () => {
        await call();
        const args = prisma.groupMember.updateMany.mock.calls[0][0];
        expect(args.where.userId).toBe('u1');
        expect(args.where.groupId).toBe('grp_A');
        // Without this a BLOCKED or REMOVED member could still write.
        expect(args.where.status).toBe('active');
        // Without this a caller could name another tenant's group id; without
        // isActive an archived group would accept a write that resurfaces on
        // restore.
        expect(args.where.group).toEqual({ organizationId: 'org1', isActive: true });
        expect(args.data).toHaveProperty(field);
      });

      it(`${name} writes ONLY its own field (never the other setting)`, async () => {
        await call();
        const other =
          field === 'isVacationMode' ? 'isDefaultAttendance' : 'isVacationMode';
        expect(prisma.groupMember.updateMany.mock.calls[0][0].data).not
          .toHaveProperty(other);
      });

      it(`${name} reports FAILURE when no row matched`, async () => {
        prisma.groupMember.updateMany.mockResolvedValue({ count: 0 });
        // The service turns this into the 403 — swallowing it would let a
        // foreign-group write report success.
        await expect(call()).resolves.toBe(false);
      });

      it(`${name} reports success when a row matched`, async () => {
        await expect(call()).resolves.toBe(true);
      });
    }

    it('ORG-WIDE vacation clears every per-group override, in ONE round trip', async () => {
      // `member ?? user` means an explicit per-group value BEATS the user flag.
      // That is correct for a per-group Return Early, but it also meant that
      // once a member had used the per-group toggle, an admin forcing vacation
      // org-wide got a 200 and sent a "turned ON by your admin" push while that
      // group kept billing them. Clearing the overrides restores inheritance so
      // "org-wide" genuinely governs every group again.
      prisma.user.update = jest.fn().mockResolvedValue({ isVacationMode: true });
      prisma.$transaction = jest
        .fn()
        .mockResolvedValue([{ isVacationMode: true }, { count: 2 }]);

      await repo.setVacationModeOrgWide('u1', true);

      // ONE round trip — both statements are pipelined, so this costs no extra
      // wave versus the single `update` it replaced.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const [statements] = prisma.$transaction.mock.calls[0];
      expect(statements).toHaveLength(2);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { isVacationMode: true },
      });
      const clear = prisma.groupMember.updateMany.mock.calls.at(-1)[0];
      expect(clear.where.userId).toBe('u1');
      // NULL is "inherit", which is the whole point — never `false`, which
      // would be a NEW explicit override shadowing the org-wide value again.
      expect(clear.data).toEqual({ isVacationMode: null });
      // Only rows that actually carry an override are touched.
      expect(clear.where.isVacationMode).toEqual({ not: null });
      // Auto-attendance is a separate preference the actor never addressed.
      expect(clear.data).not.toHaveProperty('isDefaultAttendance');
    });

    it('setMemberVacationMode accepts NULL to restore inheritance', async () => {
      await repo.setMemberVacationMode('u1', 'grp_A', 'org1', null);
      expect(
        prisma.groupMember.updateMany.mock.calls[0][0].data.isVacationMode,
      ).toBeNull();
    });
  });

  describe('vacationRequiresApproval — approval-gate scope', () => {
    const whereOf = () => prisma.groupMember.findFirst.mock.calls[0][0].where;

    it('COMPATIBILITY: without a groupId ANY group demanding approval blocks', async () => {
      await repo.vacationRequiresApproval('u1');
      const where = whereOf();
      expect(where.userId).toBe('u1');
      expect(where.status).toBe('active');
      // No narrowing — the historical org-wide rule, untouched.
      expect(where.groupId).toBeUndefined();
    });

    it('with a groupId, only that one group policy decides', async () => {
      await repo.vacationRequiresApproval('u1', 'grp_A');
      expect(whereOf().groupId).toBe('grp_A');
    });

    it('always requires the group itself to be ACTIVE and approval-gated', async () => {
      await repo.vacationRequiresApproval('u1', 'grp_A');
      expect(whereOf().group).toEqual({
        isActive: true,
        vacationRequiresApproval: true,
      });
    });
  });

  describe('endCoveringVacationRequests — Return Early scope', () => {
    const whereOf = () => prisma.vacationRequest.findMany.mock.calls[0][0].where;

    it('COMPATIBILITY: without a groupId the filter is unscoped, as before', async () => {
      await repo.endCoveringVacationRequests('u1');
      const where = whereOf();
      expect(where.userId).toBe('u1');
      expect(where.status).toBe('approved');
      expect(where.deletedAt).toBeNull();
      // No group narrowing at all — every covering request is still ended.
      expect(where.OR).toBeUndefined();
      expect(where.groupId).toBeUndefined();
    });

    it('with a groupId, narrows to THAT group plus org-level requests', async () => {
      await repo.endCoveringVacationRequests('u1', 'grp_A');
      expect(whereOf().OR).toEqual([{ groupId: 'grp_A' }, { groupId: null }]);
    });

    it('keeps org-level requests in scope — they genuinely cover this group', async () => {
      await repo.endCoveringVacationRequests('u1', 'grp_A');
      const or = whereOf().OR as Array<Record<string, unknown>>;
      expect(or).toContainEqual({ groupId: null });
    });

    it('never narrows to the group ALONE (that would strand org-level leave)', async () => {
      await repo.endCoveringVacationRequests('u1', 'grp_A');
      expect(whereOf().groupId).toBeUndefined();
    });

    it('still filters to requests covering TODAY in both modes', async () => {
      await repo.endCoveringVacationRequests('u1', 'grp_A');
      const where = whereOf();
      expect(where.startDate).toHaveProperty('lte');
      expect(where.endDate).toHaveProperty('gte');
    });
  });
});
