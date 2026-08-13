/**
 * SOURCE-LEVEL OWNERSHIP of vacation state (A-full, 2026-08-12).
 *
 * Replaces the old cross-group-spill suite, which tested a READ-SIDE
 * workaround (`flagExplainedByOtherGroup`). That workaround existed because
 * the account-level flag was written from ANY covering approved request,
 * including a group-scoped one, so every reader had to un-spill it.
 *
 * Ownership is now decided where the state is WRITTEN:
 *   • GROUP-SCOPED request  -> GroupMember.isVacationMode, that group only
 *   • ORG-LEVEL request     -> User.isVacationMode, governs every group
 * Readers resolve `member ?? user`, so no compensation is needed anywhere.
 *
 * These pin that ownership directly, plus the resolution every reader applies.
 */
import {
  resolveVacationScopeGroupIds,
  splitVacationTargets,
} from '../utils/vacation-coverage.util';
import { resolveMemberFlag } from '../utils/member-settings.util';

/** What a reader sees for one group: the rule every call site applies. */
const effective = (
  memberFlag: boolean | null,
  userFlag: boolean,
): boolean =>
  resolveMemberFlag(
    { isVacationMode: memberFlag },
    { isVacationMode: userFlag },
    'isVacationMode',
  );

describe('vacation source-level ownership', () => {
  describe('WRITE target', () => {
    it('group-A vacation is owned by group A ALONE', () => {
      expect(splitVacationTargets([{ groupId: 'grp_A' }])).toEqual({
        orgLevel: false,
        groupIds: ['grp_A'],
      });
    });

    it('ORGANIZATION-WIDE vacation is owned by the account flag', () => {
      expect(splitVacationTargets([{ groupId: null }])).toEqual({
        orgLevel: true,
        groupIds: [],
      });
    });

    it('MULTIPLE GROUPS each own their own state, de-duplicated', () => {
      const out = splitVacationTargets([
        { groupId: 'grp_A' },
        { groupId: 'grp_B' },
        { groupId: 'grp_A' },
      ]);
      expect(out.orgLevel).toBe(false);
      expect(out.groupIds.sort()).toEqual(['grp_A', 'grp_B']);
    });

    it('MULTIPLE ORGANIZATIONS never share state — targets are per (user, group)', () => {
      // Group ids are globally unique (UNI-010), so a member in orgs X and Y
      // yields disjoint targets and one org can never write the other's row.
      const out = splitVacationTargets([
        { groupId: 'orgX_grp' },
        { groupId: 'orgY_grp' },
      ]);
      expect(out.orgLevel).toBe(false);
      expect(out.groupIds.sort()).toEqual(['orgX_grp', 'orgY_grp']);
    });

    it('CANCELLATION / EXPIRY own nothing — no covering request, no target', () => {
      // Both paths end with zero covering requests; the writers then restore
      // NULL (inherit) for a group and clear the account flag for org-level.
      expect(splitVacationTargets([])).toEqual({ orgLevel: false, groupIds: [] });
    });
  });

  describe('what every reader resolves', () => {
    it('GROUP-A VACATION → covered in A', () => {
      // A-full wrote member(A)=true and left the account flag alone.
      expect(effective(true, false)).toBe(true);
    });

    it('GROUP-B UNAFFECTED by a group-A vacation', () => {
      // B has no override and the account flag was never raised — this is the
      // spill, dead at the source rather than un-spilled by every reader.
      expect(effective(null, false)).toBe(false);
    });

    it('ORGANIZATION-WIDE VACATION → covered in EVERY group', () => {
      for (const g of [null, null, null]) expect(effective(g, true)).toBe(true);
    });

    it('GROUP OVERRIDE beats an organization-wide vacation', () => {
      // Per-group Return Early: explicit false wins over an inherited true.
      expect(effective(false, true)).toBe(false);
      // And the member's other groups still follow the org-wide vacation.
      expect(effective(null, true)).toBe(true);
    });

    it('EXPIRY / CANCELLATION restore inherit, not a shadowing false', () => {
      // Writers set NULL on the way out, so a later org-wide vacation still
      // reaches the group. A literal `false` would have blocked it forever.
      expect(effective(null, false)).toBe(false);
      expect(effective(null, true)).toBe(true);
    });

    it('MULTIPLE GROUPS resolve independently on the same account', () => {
      expect(effective(true, false)).toBe(true); // on leave in this one
      expect(effective(null, false)).toBe(false); // not in this one
    });
  });

  // ── The CLIENT half of ownership ────────────────────────────────────────
  //
  // `GET /auth/me` publishes `vacationScopedGroupIds` so the Flutter shell
  // resolves the same answer without another request. Still live after A-full:
  // it carries the scope for the transition window and for org-level leave.
  describe('resolveVacationScopeGroupIds — scope published to the client', () => {
    const today = new Date('2026-08-12T00:00:00Z');
    const range = (groupId: string | null, from: string, to: string) => ({
      startDate: new Date(from),
      endDate: new Date(to),
      groupId,
    });

    it('no covering request → null (governs every group)', () => {
      expect(resolveVacationScopeGroupIds([], today)).toBeNull();
    });

    it('ORG-LEVEL covering request → null (it does cover every group)', () => {
      expect(
        resolveVacationScopeGroupIds([range(null, '2026-08-10', '2026-08-14')], today),
      ).toBeNull();
    });

    it('group-scoped covering request → ONLY that group', () => {
      expect(
        resolveVacationScopeGroupIds([range('grp_A', '2026-08-10', '2026-08-14')], today),
      ).toEqual(['grp_A']);
    });

    it('two group-scoped requests → both, de-duplicated', () => {
      expect(
        resolveVacationScopeGroupIds(
          [
            range('grp_A', '2026-08-10', '2026-08-14'),
            range('grp_A', '2026-08-11', '2026-08-13'),
            range('grp_B', '2026-08-10', '2026-08-14'),
          ],
          today,
        ),
      ).toEqual(['grp_A', 'grp_B']);
    });

    it('an org-level request WINS — never a false narrowing', () => {
      // Narrowing here would tell the client it is off-vacation in every group
      // the org-level request covers — worse than the leak it replaced.
      expect(
        resolveVacationScopeGroupIds(
          [range('grp_A', '2026-08-10', '2026-08-14'), range(null, '2026-08-10', '2026-08-14')],
          today,
        ),
      ).toBeNull();
    });

    it('a request that does NOT cover today is ignored', () => {
      // The ±48h prefetch margin returns near-today rows; only the ones
      // actually covering today may narrow the scope.
      expect(
        resolveVacationScopeGroupIds([range('grp_A', '2026-08-01', '2026-08-05')], today),
      ).toBeNull();
    });

    it('BOUNDARY: a single-day request covering today counts', () => {
      expect(
        resolveVacationScopeGroupIds([range('grp_A', '2026-08-12', '2026-08-12')], today),
      ).toEqual(['grp_A']);
    });
  });
});
