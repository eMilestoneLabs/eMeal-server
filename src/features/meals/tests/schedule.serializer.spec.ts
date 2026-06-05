import { ScheduleSerializer } from '../serializers/schedule.serializer';
import { MealScheduleEntity, ScheduleEntryEntity } from '../entities/meal-schedule.entity';

/**
 * ScheduleSerializer contract tests — verifies exact Flutter JSON shape.
 *
 * Key invariants:
 *   - weekStart DateTime → weekStartDate "YYYY-MM-DD" (date-only)
 *   - dayOfWeek Int (0=Mon) → day string "monday"..."sunday"
 *   - slotKey comes from joined meal relation
 *   - mealName: entry.mealName ?? meal.displayName ?? meal.name
 *   - entries always present (empty array if no entries)
 *   - attendanceWindow null when no per-day override
 */
describe('ScheduleSerializer', () => {
  const mockEntry = new ScheduleEntryEntity({
    id: 'ent_01',
    scheduleId: 'sch_01',
    mealId: 'meal_01',
    dayOfWeek: 0, // Monday
    date: new Date('2026-01-05T00:00:00.000Z'), // Monday 2026-01-05
    openTime: null,
    closeTime: null,
    mealName: 'Poha',
    notes: 'Extra fruits today',
    meal: {
      slotKey: 'breakfast',
      name: 'Morning Meal',
      displayName: 'Breakfast',
    },
  });

  const mockLunchEntry = new ScheduleEntryEntity({
    id: 'ent_02',
    scheduleId: 'sch_01',
    mealId: 'meal_02',
    dayOfWeek: 0, // same day, second slot
    date: new Date('2026-01-05T00:00:00.000Z'),
    openTime: '12:00',
    closeTime: '13:30',
    mealName: null, // falls back to meal.displayName
    notes: null,
    meal: {
      slotKey: 'lunch',
      name: 'Afternoon Meal',
      displayName: 'Lunch',
    },
  });

  const baseSchedule = new MealScheduleEntity({
    id: 'sch_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    weekStart: new Date('2026-01-05T00:00:00.000Z'), // Monday
    isPublished: true,
    publishedAt: new Date('2026-01-04T10:00:00.000Z'),
    entries: [mockEntry, mockLunchEntry],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  // ── weekStartDate — date-only string ──────────────────────────────────

  describe('weekStartDate contract', () => {
    it('must serialize weekStart DateTime as YYYY-MM-DD date-only string', () => {
      const response = ScheduleSerializer.toResponse(baseSchedule);
      expect(response.weekStartDate).toBe('2026-01-05');
      expect(typeof response.weekStartDate).toBe('string');
      // Must NOT be a full ISO string with time
      expect(response.weekStartDate as string).not.toContain('T');
    });

    it('must NOT expose weekStart (internal field name)', () => {
      const response = ScheduleSerializer.toResponse(baseSchedule);
      expect(response).not.toHaveProperty('weekStart');
    });
  });

  // ── entries — always present ───────────────────────────────────────────

  describe('entries contract', () => {
    it('must always include entries array', () => {
      const response = ScheduleSerializer.toResponse(baseSchedule);
      expect(Array.isArray(response.entries)).toBe(true);
    });

    it('must return empty array for schedule with no entries', () => {
      const draftSchedule = new MealScheduleEntity({
        ...baseSchedule,
        entries: [],
      });
      const response = ScheduleSerializer.toResponse(draftSchedule);
      expect(response.entries).toEqual([]);
    });

    it('serializes both entries correctly', () => {
      const response = ScheduleSerializer.toResponse(baseSchedule);
      expect((response.entries as any[]).length).toBe(2);
    });
  });

  // ── entry.day — string not integer ────────────────────────────────────

  describe('entry.day — dayOfWeek Int → day string', () => {
    it.each([
      [0, 'monday'],
      [1, 'tuesday'],
      [2, 'wednesday'],
      [3, 'thursday'],
      [4, 'friday'],
      [5, 'saturday'],
      [6, 'sunday'],
    ])('converts dayOfWeek %i to "%s"', (dayOfWeek, expectedDay) => {
      const entry = new ScheduleEntryEntity({
        ...mockEntry,
        dayOfWeek,
        meal: { slotKey: 'test', name: 'Test', displayName: null },
      });
      const result = ScheduleSerializer.entryToResponse(entry);
      expect(result.day).toBe(expectedDay);
    });

    it('must NOT expose dayOfWeek integer', () => {
      const result = ScheduleSerializer.entryToResponse(mockEntry);
      expect(result).not.toHaveProperty('dayOfWeek');
    });
  });

  // ── entry.slotKey — from meal relation ────────────────────────────────

  describe('entry.slotKey — derived from meal join', () => {
    it('uses slotKey from joined meal', () => {
      const entry = ScheduleSerializer.entryToResponse(mockEntry) as any;
      expect(entry.slotKey).toBe('breakfast');
    });

    it('handles missing meal gracefully', () => {
      const entryWithoutMeal = new ScheduleEntryEntity({
        ...mockEntry,
        meal: undefined,
      });
      const result = ScheduleSerializer.entryToResponse(entryWithoutMeal) as any;
      expect(result.slotKey).toBe('');
    });
  });

  // ── mealName fallback chain ────────────────────────────────────────────

  describe('mealName fallback', () => {
    it('uses entry.mealName when set', () => {
      const result = ScheduleSerializer.entryToResponse(mockEntry) as any;
      expect(result.mealName).toBe('Poha');
    });

    it('falls back to meal.displayName when entry.mealName is null', () => {
      const result = ScheduleSerializer.entryToResponse(mockLunchEntry) as any;
      expect(result.mealName).toBe('Lunch'); // meal.displayName
    });

    it('falls back to meal.name when both mealName and displayName are null', () => {
      const entry = new ScheduleEntryEntity({
        ...mockEntry,
        mealName: null,
        meal: { slotKey: 'dinner', name: 'Evening Meal', displayName: null },
      });
      const result = ScheduleSerializer.entryToResponse(entry) as any;
      expect(result.mealName).toBe('Evening Meal');
    });
  });

  // ── attendanceWindow per-day override ─────────────────────────────────

  describe('attendanceWindow per-day override', () => {
    it('returns null when no per-day override', () => {
      const result = ScheduleSerializer.entryToResponse(mockEntry) as any;
      expect(result.attendanceWindow).toBeNull();
    });

    it('returns nested object when override is set', () => {
      const result = ScheduleSerializer.entryToResponse(mockLunchEntry) as any;
      expect(result.attendanceWindow).toEqual({
        openTime: '12:00',
        closeTime: '13:30',
      });
    });
  });

  // ── date serialization ────────────────────────────────────────────────

  describe('date serialization', () => {
    it('entry.date must be YYYY-MM-DD string (not full ISO)', () => {
      const result = ScheduleSerializer.entryToResponse(mockEntry) as any;
      expect(result.date).toBe('2026-01-05');
      expect(result.date).not.toContain('T');
    });

    it('publishedAt is ISO string when published', () => {
      const response = ScheduleSerializer.toResponse(baseSchedule);
      expect(typeof response.publishedAt).toBe('string');
      expect(response.publishedAt as string).toContain('T');
    });

    it('publishedAt is null for draft schedule', () => {
      const draft = new MealScheduleEntity({
        ...baseSchedule,
        isPublished: false,
        publishedAt: null,
        entries: [],
      });
      const response = ScheduleSerializer.toResponse(draft);
      expect(response.publishedAt).toBeNull();
    });
  });

  // ── exact Flutter contract keys ────────────────────────────────────────

  describe('Flutter contract — exact top-level keys', () => {
    it('schedule must have all required keys', () => {
      const response = ScheduleSerializer.toResponse(baseSchedule);
      const expectedKeys = ['id', 'groupId', 'weekStartDate', 'isPublished', 'publishedAt', 'entries', 'createdAt'];
      expectedKeys.forEach((key) => {
        expect(response).toHaveProperty(key);
      });
    });

    it('entry must have all required keys', () => {
      const result = ScheduleSerializer.entryToResponse(mockEntry);
      const expectedKeys = ['id', 'mealId', 'day', 'slotKey', 'mealName', 'notes', 'date', 'attendanceWindow'];
      expectedKeys.forEach((key) => {
        expect(result).toHaveProperty(key);
      });
    });
  });
});
