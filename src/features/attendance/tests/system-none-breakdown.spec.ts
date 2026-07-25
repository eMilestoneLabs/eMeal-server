import { AttendanceRepository } from '../repositories/attendance.repository';
import {
  normalizePreferenceKey,
  isSystemNonePreference,
  SYSTEM_NONE_FLAT_KEY,
} from '../../../common/utils/system-none.util';

/**
 * ISSUE-002 (Live-Test-13) — hidden system-None accounting.
 *
 * Locks BOTH directions of the fix so neither can be undone by accident:
 *  1. On a STANDALONE-preference meal, a PRESENT record with NO preference is
 *     the system None — it must land in the hidden None tally, otherwise
 *     (visible + None) falls short of Total Present and the Kitchen Summary
 *     shows a permanent red "data mismatch".
 *  2. On a preference-FREE meal every record is legitimately NULL, so the fold
 *     must NOT happen — folding there would invent an empty "Standalone
 *     Preference" section on the dashboard (the Flutter section renders
 *     whenever the flat breakdown is non-empty).
 */
describe('ISSUE-002 system-None preference accounting', () => {
  describe('normalizePreferenceKey (shared member/guest rule)', () => {
    it('folds NULL / blank into the flat None key', () => {
      expect(normalizePreferenceKey(null)).toBe(SYSTEM_NONE_FLAT_KEY);
      expect(normalizePreferenceKey(undefined)).toBe(SYSTEM_NONE_FLAT_KEY);
      expect(normalizePreferenceKey('   ')).toBe(SYSTEM_NONE_FLAT_KEY);
    });

    it('collapses BOTH stored spellings onto ONE key (tally never splits)', () => {
      expect(normalizePreferenceKey('none')).toBe(SYSTEM_NONE_FLAT_KEY);
      expect(normalizePreferenceKey('__none__')).toBe(SYSTEM_NONE_FLAT_KEY);
      expect(normalizePreferenceKey('  NONE  ')).toBe(SYSTEM_NONE_FLAT_KEY);
    });

    it('passes real tags through untouched', () => {
      expect(normalizePreferenceKey('chicken')).toBe('chicken');
      expect(normalizePreferenceKey('Fish')).toBe('Fish');
    });

    it('isSystemNonePreference stays FALSE for null — "is None" != "counts as None"', () => {
      // Validation code must not mistake a missing pick for an explicit one.
      expect(isSystemNonePreference(null)).toBe(false);
      expect(isSystemNonePreference('none')).toBe(true);
      expect(isSystemNonePreference('__none__')).toBe(true);
      expect(isSystemNonePreference('chicken')).toBe(false);
    });
  });

  describe('getMealSummary preference breakdown', () => {
    /** prisma double: 3 attendanceRecord.groupBy calls + 2 selection ones. */
    const prismaWith = (prefRows: unknown[]) => {
      const capture: { where?: any } = {};
      return {
        capture,
        prisma: {
          attendanceRecord: {
            groupBy: jest.fn(async (args: any) => {
              if (args.by[0] === 'status') {
                return [{ status: 'present', _count: { status: 3 } }];
              }
              if (args.by[0] === 'preference') {
                capture.where = args.where;
                return prefRows;
              }
              return []; // price
            }),
          },
          attendancePreferenceSelection: { groupBy: jest.fn(async () => []) },
        } as never,
      };
    };

    it('STANDALONE meal: PRESENT rows with no preference count as hidden None', async () => {
      const { prisma } = prismaWith([
        { preference: 'chicken', _count: { _all: 2 } },
        { preference: null, _count: { _all: 5 } }, // legacy / guest-optional
      ]);
      const summary = await new AttendanceRepository(prisma).getMealSummary(
        'meal_01', 'org_01', new Date('2026-07-25T00:00:00.000Z'), true,
      );
      expect(summary.preferenceBreakdown).toEqual({ chicken: 2, none: 5 });
    });

    it('STANDALONE meal: NULL and an explicit "none" MERGE into one bucket', async () => {
      const { prisma } = prismaWith([
        { preference: null, _count: { _all: 4 } },
        { preference: 'none', _count: { _all: 3 } },
        { preference: '__none__', _count: { _all: 1 } },
      ]);
      const summary = await new AttendanceRepository(prisma).getMealSummary(
        'meal_01', 'org_01', new Date('2026-07-25T00:00:00.000Z'), true,
      );
      // 4 + 3 + 1 — a split tally would under-count and re-open the mismatch.
      expect(summary.preferenceBreakdown).toEqual({ none: 8 });
    });

    it('PREFERENCE-FREE meal: NULLs excluded at the QUERY — no phantom section', async () => {
      const { prisma, capture } = prismaWith([]);
      const summary = await new AttendanceRepository(prisma).getMealSummary(
        'meal_01', 'org_01', new Date('2026-07-25T00:00:00.000Z'), false,
      );
      expect(capture.where.preference).toEqual({ not: null });
      expect(summary.preferenceBreakdown).toEqual({});
    });

    it('defaults to the legacy exclude-NULL behaviour when the flag is omitted', async () => {
      const { prisma, capture } = prismaWith([]);
      await new AttendanceRepository(prisma).getMealSummary(
        'meal_01', 'org_01', new Date('2026-07-25T00:00:00.000Z'),
      );
      expect(capture.where.preference).toEqual({ not: null });
    });
  });
});
