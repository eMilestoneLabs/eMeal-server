/**
 * A-full: WHERE a covering approved request's vacation state is written.
 *
 * `User.isVacationMode` is one ACCOUNT-level bit. A request scoped to ONE
 * group has no room in it, so writing there marked the member on vacation in
 * EVERY group they belong to — gating meal marking, corrections, reminders and
 * the admin roster/billing view for a group they never requested leave from.
 *
 * splitVacationTargets is the ONE definition of that rule, shared by all three
 * writers (read-time sync, approve/cancel, FR-VACX-006 sweep) so they cannot
 * drift — drift is the only way this breaks.
 */
import { splitVacationTargets } from '../utils/vacation-coverage.util';

describe('splitVacationTargets — where vacation state belongs', () => {
  it('BASELINE: an ORG-LEVEL request keeps the ACCOUNT flag as its home', () => {
    // Byte-identical to the behaviour before group scoping existed.
    expect(splitVacationTargets([{ groupId: null }])).toEqual({
      orgLevel: true,
      groupIds: [],
    });
  });

  it('a GROUP-SCOPED request targets ONLY its own membership', () => {
    // The whole fix: nothing account-level is written, so the member's other
    // groups keep inheriting `false`.
    expect(splitVacationTargets([{ groupId: 'grp_A' }])).toEqual({
      orgLevel: false,
      groupIds: ['grp_A'],
    });
  });

  it('leave in two groups targets both memberships, de-duplicated', () => {
    const out = splitVacationTargets([
      { groupId: 'grp_A' },
      { groupId: 'grp_A' },
      { groupId: 'grp_B' },
    ]);
    expect(out.orgLevel).toBe(false);
    expect(out.groupIds.sort()).toEqual(['grp_A', 'grp_B']);
  });

  it('org-level AND group-scoped together yield BOTH targets', () => {
    // FR-VACX-001's overlap guard makes this unreachable today, but encoding
    // that assumption would make the rule wrong the day the policy changes.
    const out = splitVacationTargets([{ groupId: null }, { groupId: 'grp_A' }]);
    expect(out.orgLevel).toBe(true);
    expect(out.groupIds).toEqual(['grp_A']);
  });

  it('no covering request writes nothing at all', () => {
    expect(splitVacationTargets([])).toEqual({ orgLevel: false, groupIds: [] });
  });

  it('treats undefined groupId as ORG-LEVEL (fail-safe, never a lost vacation)', () => {
    // A row read without the column must not silently become group-scoped and
    // land nowhere — the safe direction is the account flag.
    expect(splitVacationTargets([{}]).orgLevel).toBe(true);
  });
});
