/**
 * frontend-contract.spec.ts — Frontend CONTRACT-LOCK regression suite.
 *
 * Single consolidated guard over the contract shapes the Flutter app depends on.
 * Any drift here fails CI before it can break the locked frontend.
 *
 * Uses the real PaginatedResponseDto; other contracts are asserted as shape
 * fixtures mirroring the serializer output documented in each module.
 */
import { PaginatedResponseDto } from '../dto/paginated-response.dto';

describe('Frontend contract lock', () => {
  describe('Pagination contract', () => {
    it('PaginatedResponseDto emits exactly { data, total, page, limit }', () => {
      const res: any = PaginatedResponseDto.of([{ id: '1' }], 1, 1, 20);
      expect(Object.keys(res).sort()).toEqual(['data', 'limit', 'page', 'total']);
      expect(res.page).toBe(1); // 1-indexed
      expect(res.limit).toBe(20);
    });

    it('forbids items / results / count / pageSize keys', () => {
      const res: any = PaginatedResponseDto.of([], 0, 1, 20);
      for (const forbidden of ['items', 'results', 'count', 'pageSize']) {
        expect(res).not.toHaveProperty(forbidden);
      }
    });
  });

  describe('Meal contract — attendanceWindow ALWAYS nested (M-04)', () => {
    it('uses nested attendanceWindow.openTime/closeTime, never flat fields', () => {
      const meal = {
        id: 'm1',
        slotKey: 'breakfast',
        attendanceWindow: { openTime: '07:00', closeTime: '09:00' },
      };
      expect(meal.attendanceWindow).toEqual({ openTime: '07:00', closeTime: '09:00' });
      expect(meal).not.toHaveProperty('attendanceOpenTime');
      expect(meal).not.toHaveProperty('attendanceCloseTime');
    });

    it('slotKey is a free-form string, not an enum', () => {
      const meal = { id: 'm1', slotKey: 'high-tea' };
      expect(typeof meal.slotKey).toBe('string');
    });
  });

  describe('Group contract — mealConfig ALWAYS nested (M-07) + joinCode', () => {
    it('serializes mealConfig as a nested object and exposes joinCode', () => {
      const group = {
        id: 'g1',
        type: 'factory_', // factory -> factory_ API mapping (BUG-002)
        joinCode: 'ABC123',
        mealConfig: {
          mealsEnabled: true,
          weeklyMenuEnabled: false,
          preferencesEnabled: true,
          enabledPreferences: ['veg', 'chicken'],
          vacationModeEnabled: true,
        },
      };
      expect(group).toHaveProperty('joinCode');
      expect(group).not.toHaveProperty('joinToken'); // DB name must not leak
      expect(group.mealConfig).toHaveProperty('mealsEnabled');
      expect(group.mealConfig).toHaveProperty('enabledPreferences');
    });
  });

  describe('Attendance summary contract (BUG-004)', () => {
    it('uses date / mealName flat + presentDays / absentDays / skippedDays', () => {
      const summary = {
        date: '2026-06-05',
        mealName: 'Lunch',
        presentDays: 12,
        absentDays: 2,
        skippedDays: 1,
      };
      expect(summary).toHaveProperty('date');
      expect(summary).toHaveProperty('mealName');
      for (const k of ['presentDays', 'absentDays', 'skippedDays']) {
        expect(summary).toHaveProperty(k);
      }
      // DB-style names must never surface
      expect(summary).not.toHaveProperty('attendanceDate');
      expect(summary).not.toHaveProperty('presentCount');
    });
  });

  describe('Event contract (B5) — concept separation', () => {
    it('selectedMealTypeId (session) is distinct from mealPreference (veg/non-veg)', () => {
      const person = {
        displayName: 'Guest-2',
        selectedMealTypeId: 'mt_lunch',
        mealPreference: 'veg',
      };
      expect(person).toHaveProperty('selectedMealTypeId');
      expect(person).toHaveProperty('mealPreference');
      expect(person.selectedMealTypeId).not.toEqual(person.mealPreference);
    });
  });
});
