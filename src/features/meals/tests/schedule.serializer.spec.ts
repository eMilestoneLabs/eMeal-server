import { ScheduleSerializer } from '../serializers/schedule.serializer';
import { MealScheduleEntity, ScheduleEntryEntity } from '../entities/meal-schedule.entity';

/**
 * ScheduleSerializer contract tests — verifies the exact Flutter JSON shape
 * the app is locked to (M-12):
 *
 *   - top-level: id, groupId, organizationId, isPublished, publishedAt, createdAt, days
 *   - days[] ALWAYS has 7 entries (monday..sunday), empty meals[] if none
 *   - meal item: mealId, name, slotKey, order, menuItems, imageUrl, openTime, closeTime
 *   - name fallback: entry.mealName ?? meal.displayName ?? meal.name
 *   - openTime/closeTime are FLAT per-day overrides (null when unset)
 */
describe('ScheduleSerializer', () => {
  const breakfast = new ScheduleEntryEntity({
    id: 'ent_01',
    scheduleId: 'sch_01',
    mealId: 'meal_01',
    dayOfWeek: 0, // Monday
    date: new Date('2026-01-05T00:00:00.000Z'),
    openTime: null,
    closeTime: null,
    mealName: 'Poha',
    notes: 'Extra fruits today',
    meal: {
      slotKey: 'breakfast',
      name: 'Morning Meal',
      displayName: 'Breakfast',
      order: 1,
      menuItems: ['Poha'],
      imageUrl: null,
    },
  });

  const lunch = new ScheduleEntryEntity({
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
      order: 2,
      menuItems: [],
      imageUrl: null,
    },
  });

  const baseSchedule = new MealScheduleEntity({
    id: 'sch_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    weekStart: new Date('2026-01-05T00:00:00.000Z'),
    isPublished: true,
    publishedAt: new Date('2026-01-04T10:00:00.000Z'),
    entries: [breakfast, lunch],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  describe('top-level contract', () => {
    it('exposes the exact locked top-level keys', () => {
      const res = ScheduleSerializer.toResponse(baseSchedule);
      ['id', 'groupId', 'organizationId', 'isPublished', 'publishedAt', 'createdAt', 'days'].forEach(
        (k) => expect(res).toHaveProperty(k),
      );
    });

    it('uses days[] (NOT entries) and never exposes weekStart', () => {
      const res = ScheduleSerializer.toResponse(baseSchedule) as any;
      expect(Array.isArray(res.days)).toBe(true);
      expect(res).not.toHaveProperty('entries');
      expect(res).not.toHaveProperty('weekStart');
    });

    it('always renders all 7 days, empty meals[] when none', () => {
      const res = ScheduleSerializer.toResponse(baseSchedule) as any;
      expect(res.days).toHaveLength(7);
      expect(res.days.map((d: any) => d.day)).toEqual([
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
      ]);
      expect(res.days[1].meals).toEqual([]); // tuesday empty
    });

    it('publishedAt is ISO when published, null for draft', () => {
      const res = ScheduleSerializer.toResponse(baseSchedule) as any;
      expect(typeof res.publishedAt).toBe('string');
      expect(res.publishedAt).toContain('T');
      const draft = new MealScheduleEntity({
        ...baseSchedule, isPublished: false, publishedAt: null, entries: [],
      });
      expect(ScheduleSerializer.toResponse(draft).publishedAt).toBeNull();
    });
  });

  describe('days[].meals[] — ordering + shape', () => {
    it('groups both Monday meals and sorts them by meal.order', () => {
      const res = ScheduleSerializer.toResponse(baseSchedule) as any;
      const monday = res.days[0];
      expect(monday.day).toBe('monday');
      expect(monday.meals).toHaveLength(2);
      expect(monday.meals[0].slotKey).toBe('breakfast'); // order 1 first
      expect(monday.meals[1].slotKey).toBe('lunch');     // order 2 second
    });

    it('meal item carries the exact contract keys', () => {
      const item = ScheduleSerializer.entryToMealItem(breakfast) as any;
      ['mealId', 'name', 'slotKey', 'order', 'menuItems', 'imageUrl', 'openTime', 'closeTime'].forEach(
        (k) => expect(item).toHaveProperty(k),
      );
      expect(item).not.toHaveProperty('attendanceWindow'); // flat, not nested
    });
  });

  describe('entryToMealItem — name fallback + derived fields', () => {
    it('uses entry.mealName when present', () => {
      expect((ScheduleSerializer.entryToMealItem(breakfast) as any).name).toBe('Poha');
    });

    it('falls back to meal.displayName when mealName is null', () => {
      expect((ScheduleSerializer.entryToMealItem(lunch) as any).name).toBe('Lunch');
    });

    it('falls back to meal.name when mealName and displayName are null', () => {
      const entry = new ScheduleEntryEntity({
        ...breakfast,
        mealName: null,
        meal: { slotKey: 'dinner', name: 'Evening Meal', displayName: null, order: 3, menuItems: [], imageUrl: null },
      });
      expect((ScheduleSerializer.entryToMealItem(entry) as any).name).toBe('Evening Meal');
    });

    it('derives slotKey from the joined meal, empty string when meal missing', () => {
      expect((ScheduleSerializer.entryToMealItem(breakfast) as any).slotKey).toBe('breakfast');
      const noMeal = new ScheduleEntryEntity({ ...breakfast, meal: undefined });
      expect((ScheduleSerializer.entryToMealItem(noMeal) as any).slotKey).toBe('');
    });

    it('exposes flat per-day openTime/closeTime overrides', () => {
      expect((ScheduleSerializer.entryToMealItem(breakfast) as any).openTime).toBeNull();
      const item = ScheduleSerializer.entryToMealItem(lunch) as any;
      expect(item.openTime).toBe('12:00');
      expect(item.closeTime).toBe('13:30');
    });
  });
});
