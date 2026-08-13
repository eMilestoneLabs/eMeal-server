/**
 * The per-group member-settings ride-along, and the allocation guard on it.
 *
 * Only the DETAIL read (`findById` via `memberSelectWithSettings`) selects the
 * two per-group columns, because `getGroupById` is the only caller that
 * surfaces them as `myMemberSettings`. The LIST paths (`findAll`,
 * `findByMembership`, `findByJoinCode`, `findPendingJoinGroupsForUser`) keep
 * the original narrow select.
 *
 * `buildEntity` must respect that split. Building the settings Map
 * unconditionally would allocate a Map per group PLUS one object per member on
 * the hottest group read, every entry all-null, for data nothing there reads.
 * The caps are configurable (maxGroupsPerOrg / defaultRoleMemberLimit), so this
 * is a scalability guard, not a micro-optimisation: raising them must not start
 * producing garbage proportional to groups x members.
 */
import { GroupsRepository } from '../repositories/groups.repository';

const groupRow = (members: any[]) => ({
  id: 'grp_A',
  organizationId: 'org1',
  name: 'Hostel A',
  type: 'hostel',
  isActive: true,
  members,
});

/** Member row as the DETAIL select returns it (columns present). */
const withSettings = (userId: string, vac: boolean | null) => ({
  userId,
  status: 'active',
  functionalRole: null,
  isVacationMode: vac,
  isDefaultAttendance: null,
});

/** Member row as the LIST select returns it (columns absent entirely). */
const withoutSettings = (userId: string) => ({
  userId,
  status: 'active',
  functionalRole: null,
});

describe('group member-settings ride-along', () => {
  let prisma: any;
  let repo: GroupsRepository;

  beforeEach(() => {
    prisma = { group: { findFirst: jest.fn(), findMany: jest.fn() } };
    repo = new GroupsRepository(prisma);
  });

  describe('DETAIL read — findById', () => {
    it('selects the per-group columns (they ride the include already made)', async () => {
      prisma.group.findFirst.mockResolvedValue(groupRow([]));
      await repo.findById('grp_A', 'org1');
      const select =
        prisma.group.findFirst.mock.calls[0][0].include.members.select;
      expect(select.isVacationMode).toBe(true);
      expect(select.isDefaultAttendance).toBe(true);
      // Tenant isolation on the same read — unchanged, asserted so a later
      // edit to this select cannot quietly drop it.
      expect(prisma.group.findFirst.mock.calls[0][0].where.organizationId).toBe(
        'org1',
      );
    });

    it('exposes the requesting member own override', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([withSettings('u1', true), withSettings('u2', false)]),
      );
      const g = await repo.findById('grp_A', 'org1');
      expect(g!.memberSettingsOf('u1')!.isVacationMode).toBe(true);
      expect(g!.memberSettingsOf('u2')!.isVacationMode).toBe(false);
    });

    it('a member with no override reads as null (inherit), not false', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([withSettings('u1', null)]),
      );
      const g = await repo.findById('grp_A', 'org1');
      // null and false mean different things: inherit vs explicitly off.
      expect(g!.memberSettingsOf('u1')!.isVacationMode).toBeNull();
    });

    it('a non-member reads as null', async () => {
      prisma.group.findFirst.mockResolvedValue(
        groupRow([withSettings('u1', true)]),
      );
      const g = await repo.findById('grp_A', 'org1');
      expect(g!.memberSettingsOf('someone_else')).toBeNull();
    });
  });

  describe('LIST read — allocation guard', () => {
    it('does NOT select the per-group columns', async () => {
      prisma.group.findMany.mockResolvedValue([]);
      await repo.findAll('org1', { page: 1, limit: 20 } as never);
      const select =
        prisma.group.findMany.mock.calls[0][0].include.members.select;
      expect(select.isVacationMode).toBeUndefined();
      expect(select.isDefaultAttendance).toBeUndefined();
      // The narrow clause the list paths have always used.
      expect(Object.keys(select).sort()).toEqual([
        'functionalRole',
        'status',
        'userId',
      ]);
    });

    it('allocates NO settings map when the columns were not selected', async () => {
      prisma.group.findMany.mockResolvedValue([
        groupRow([withoutSettings('u1'), withoutSettings('u2')]),
      ]);
      const res: any = await repo.findAll('org1', {
        page: 1,
        limit: 20,
      } as never);
      const entity = res.data[0];
      // Undefined, not an all-null Map: on the hot list read this is one Map
      // plus one object PER MEMBER PER GROUP of pure garbage.
      expect(entity.memberSettings).toBeUndefined();
      // And the accessor still answers safely without it.
      expect(entity.memberSettingsOf('u1')).toBeNull();
    });

    it('still resolves functional roles on the list path (unchanged)', async () => {
      prisma.group.findMany.mockResolvedValue([
        groupRow([{ ...withoutSettings('u1'), functionalRole: 'messManager' }]),
      ]);
      const res: any = await repo.findAll('org1', {
        page: 1,
        limit: 20,
      } as never);
      expect(res.data[0].functionalRoleOf('u1')).toBe('messManager');
    });
  });
});
