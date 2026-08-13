/**
 * EXHAUSTIVE scenario matrix for group-scoped vacation.
 *
 * Every earlier defect was found by hand-picking a scenario. This enumerates
 * the FULL cross-product instead, and asserts each against the SPEC stated
 * independently below — not against the implementation, or the test would
 * merely restate the bug.
 *
 * SPEC (SRS Module 03 / FR-VACX-001..006). A member is on vacation in group G
 * on date D if and only if:
 *   1. an APPROVED, non-deleted request covers D and governs G — it governs G
 *      when `groupId === G` (its own group) or `groupId === null` (org-level,
 *      governs every group); OR
 *   2. no such request exists, and the EFFECTIVE flag is on:
 *      `member(G) ?? user`  (NULL member = inherit the account flag).
 * A request that governs D wins outright: activation lag must never change a
 * billing outcome.
 */
import { getVacationCoveredUserIds } from '../utils/vacation-coverage.util';
import { resolveMemberFlag } from '../utils/member-settings.util';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const DATE = d('2026-08-13');

type Scope = 'none' | 'org' | 'A' | 'B';
type Member = null | true | false;

const REQ: Record<Exclude<Scope, 'none'>, string | null> = {
  org: null,
  A: 'grp_A',
  B: 'grp_B',
};

/** The SPEC, written independently of the implementation. */
function specSaysOnVacation(
  scope: Scope,
  covering: boolean,
  member: Member,
  userFlag: boolean,
  viewing: string,
): boolean {
  if (scope !== 'none' && covering) {
    const g = REQ[scope];
    if (g === null || g === viewing) return true; // rule 1
    // a foreign group's request does not govern here -> fall through to rule 2
  }
  return member ?? userFlag; // rule 2
}

const run = async (
  requests: any[],
  viewing: string,
  effectiveFlag: boolean,
): Promise<boolean> => {
  const covered = await getVacationCoveredUserIds(
    {
      // The REAL query filters `startDate <= date <= endDate`, so only
      // COVERING rows ever reach the resolver. The mock must honour that
      // invariant or it tests a state the database cannot produce.
      vacationRequest: {
        findMany: async () =>
          requests.filter(
            (r: any) => r.startDate <= DATE && r.endDate >= DATE,
          ),
      },
      meal: { findMany: async () => [] },
    } as any,
    {
      organizationId: 'org1',
      groupId: viewing,
      dateUtc: DATE,
      mealOpenTime: null,
      candidates: [{ userId: 'u1', isVacationMode: effectiveFlag }],
    },
  );
  return covered.has('u1');
};

describe('vacation scenario matrix — full cross-product vs SPEC', () => {
  const scopes: Scope[] = ['none', 'org', 'A', 'B'];
  const coverings = [true, false];
  const members: Member[] = [null, true, false];
  const flags = [true, false];
  const viewings = ['grp_A', 'grp_B'];

  const cases: Array<[Scope, boolean, Member, boolean, string]> = [];
  for (const s of scopes)
    for (const c of coverings)
      for (const m of members)
        for (const f of flags)
          for (const v of viewings)
            if (!(s === 'none' && c)) cases.push([s, c, m, f, v]);

  it('enumerates every combination with no gaps', () => {
    // 4 scopes x 2 coverings x 3 member states x 2 account flags x 2 groups,
    // minus the impossible "no request but covering" pairs.
    expect(cases.length).toBe(84);
  });

  for (const [scope, covering, member, flag, viewing] of cases) {
    const label =
      `request=${scope}${scope === 'none' ? '' : covering ? '(covering)' : '(ended)'} ` +
      `member=${String(member)} account=${flag} viewing=${viewing}`;

    it(label, async () => {
      const requests =
        scope === 'none'
          ? []
          : [
              {
                userId: 'u1',
                groupId: REQ[scope],
                startDate: covering ? d('2026-08-10') : d('2026-08-01'),
                endDate: covering ? d('2026-08-20') : d('2026-08-05'),
                startSlotKey: null,
                endSlotKey: null,
              },
            ];

      // The effective flag every caller computes before invoking the resolver.
      const effectiveFlag = resolveMemberFlag(
        { isVacationMode: member },
        { isVacationMode: flag },
        'isVacationMode',
      );

      const actual = await run(requests, viewing, effectiveFlag);
      const expected = specSaysOnVacation(scope, covering, member, flag, viewing);
      expect(actual).toBe(expected);
    });
  }
});
