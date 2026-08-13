/**
 * Per-group member settings — the resolution rule and its two traps.
 *
 * Group-scoped vacation / auto-attendance are stored as NULLABLE columns on
 * `GroupMember`, where NULL means "inherit the user-level flag". Two things
 * must hold, and both are the kind of thing that silently changes money:
 *
 *   1. BASELINE IDENTITY — every row that existed before the migration is
 *      NULL, so the effective value must be exactly the old user-level value.
 *      This is what makes shipping the read layer ahead of any writer a no-op
 *      in production rather than a behaviour change.
 *
 *   2. `??` NOT `||` — an explicit per-group `false` must beat an inherited
 *      `true`. With `||` a member who switched a setting off in ONE group
 *      would silently fall through to the user flag and have it back on.
 *
 * The `memberFlagWhere` block additionally pins the SHAPE of the SQL filter:
 * it must stay a positive OR. `NOT(NULL)` is `NULL` in SQL, so expressing the
 * same filter as a negation drops every member still inheriting — they lose
 * their reminders, then get neutralized or auto-marked at window close, which
 * changes what they are billed.
 */
import {
  memberFlagWhere,
  resolveMemberFlag,
} from '../utils/member-settings.util';

describe('resolveMemberFlag — per-group member settings', () => {
  describe('BASELINE IDENTITY: a NULL override reproduces the old behaviour', () => {
    it.each([
      ['isVacationMode', true],
      ['isVacationMode', false],
      ['isDefaultAttendance', true],
      ['isDefaultAttendance', false],
    ] as const)('%s: null override inherits user=%s', (key, userValue) => {
      expect(resolveMemberFlag({ [key]: null }, { [key]: userValue }, key)).toBe(
        userValue,
      );
    });

    it('an absent column (row read before the migration) also inherits', () => {
      expect(
        resolveMemberFlag({}, { isVacationMode: true }, 'isVacationMode'),
      ).toBe(true);
    });

    it('a missing membership row falls back to the user flag', () => {
      expect(
        resolveMemberFlag(null, { isDefaultAttendance: true }, 'isDefaultAttendance'),
      ).toBe(true);
    });

    it('nothing at all resolves to false, matching the old `?? false`', () => {
      expect(resolveMemberFlag(null, null, 'isVacationMode')).toBe(false);
      expect(resolveMemberFlag(undefined, {}, 'isDefaultAttendance')).toBe(false);
    });
  });

  describe('the override governs its own group', () => {
    it('per-group TRUE wins over a user flag that is off', () => {
      expect(
        resolveMemberFlag(
          { isVacationMode: true },
          { isVacationMode: false },
          'isVacationMode',
        ),
      ).toBe(true);
    });

    // The `||`-instead-of-`??` regression lives exactly here: `false || true`
    // is true, so this is the single assertion that catches it.
    it('per-group FALSE wins over an inherited TRUE (`??`, never `||`)', () => {
      expect(
        resolveMemberFlag(
          { isVacationMode: false },
          { isVacationMode: true },
          'isVacationMode',
        ),
      ).toBe(false);
      expect(
        resolveMemberFlag(
          { isDefaultAttendance: false },
          { isDefaultAttendance: true },
          'isDefaultAttendance',
        ),
      ).toBe(false);
    });

    it('resolves each setting independently — one group, two settings', () => {
      const member = { isVacationMode: true, isDefaultAttendance: false };
      const user = { isVacationMode: false, isDefaultAttendance: true };
      expect(resolveMemberFlag(member, user, 'isVacationMode')).toBe(true);
      expect(resolveMemberFlag(member, user, 'isDefaultAttendance')).toBe(false);
    });
  });
});

describe('memberFlagWhere — NULL-safe Prisma filter', () => {
  it('matches rows with an explicit override AND rows still inheriting', () => {
    expect(memberFlagWhere('isDefaultAttendance', true)).toEqual({
      OR: [
        { isDefaultAttendance: true },
        { isDefaultAttendance: null, user: { isDefaultAttendance: true } },
      ],
    });
  });

  it('carries the expected value into BOTH branches (false is a real filter)', () => {
    expect(memberFlagWhere('isVacationMode', false)).toEqual({
      OR: [
        { isVacationMode: false },
        { isVacationMode: null, user: { isVacationMode: false } },
      ],
    });
  });

  // Shape guard, not a style check: the inherit branch is what keeps every
  // pre-migration member in the result set. Rewriting this as `NOT { ... }`
  // type-checks, reads as equivalent, and silently drops all of them.
  it('is a POSITIVE OR — never a NOT wrapper, and always keeps the inherit branch', () => {
    for (const expected of [true, false]) {
      const where: any = memberFlagWhere('isVacationMode', expected);
      expect(Object.keys(where)).toEqual(['OR']);
      expect(where.OR).toHaveLength(2);
      expect(JSON.stringify(where)).not.toContain('NOT');
      const inherit = where.OR.find((b: any) => b.isVacationMode === null);
      expect(inherit).toBeDefined();
      expect(inherit.user).toEqual({ isVacationMode: expected });
    }
  });
});
