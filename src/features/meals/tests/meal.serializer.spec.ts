import { MealSerializer } from '../serializers/meal.serializer';
import { MealEntity } from '../entities/meal.entity';

/**
 * MealSerializer contract tests — verifies the LOCKED Flutter JSON shape
 * (see serializer header: lib/shared/models/meal_model.dart).
 *
 * Locked invariants (NEVER renamed):
 *   - json['name']               (displayName overrides name when set)
 *   - json['isActive']           (NOT isEnabled)
 *   - json['enabledPreferences'] (NOT preferences)
 *   - json['slotKey']            free-form string, never an enum
 *   - json['attendanceWindow']   ALWAYS nested { openTime, closeTime } | null
 *   - json['organizationId']     exposed
 */
describe('MealSerializer', () => {
  const baseMeal = new MealEntity({
    id: 'meal_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    slotKey: 'breakfast',
    name: 'Morning Meal',
    displayName: 'Breakfast',
    order: 1,
    isActive: true,
    attendanceEnabled: true,
    description: 'Start the day right',
    menuItems: ['Poha', 'Tea', 'Banana'],
    imageUrl: null,
    preferencesEnabled: true,
    enabledPreferences: ['veg', 'egg'],
    attendanceWindowOpen: '06:00',
    attendanceWindowClose: '09:00',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  describe('slotKey contract (dynamic rendering architecture)', () => {
    it('passes through slotKey as-is — never hardcoded', () => {
      expect(MealSerializer.toResponse(baseMeal).slotKey).toBe('breakfast');
    });
    it.each(['lunch', 'dinner', 'iftar', 'sehri', 'high-tea', 'midnightMeal', 'customSlot'])(
      'serializes arbitrary slotKey "%s" correctly',
      (slotKey) => {
        const meal = new MealEntity({ ...baseMeal, slotKey });
        expect(MealSerializer.toResponse(meal).slotKey).toBe(slotKey);
      },
    );
  });

  describe('name field (displayName overrides name)', () => {
    it('uses displayName as name when set', () => {
      expect(MealSerializer.toResponse(baseMeal).name).toBe('Breakfast');
    });
    it('falls back to name when displayName is null', () => {
      const meal = new MealEntity({ ...baseMeal, displayName: null });
      expect(MealSerializer.toResponse(meal).name).toBe('Morning Meal');
    });
  });

  describe('isActive field (locked — NOT isEnabled)', () => {
    it('exposes isActive, never isEnabled', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response).toHaveProperty('isActive', true);
      expect(response).not.toHaveProperty('isEnabled');
    });
    it('isActive=false when meal is soft-deleted', () => {
      const meal = new MealEntity({ ...baseMeal, isActive: false });
      expect(MealSerializer.toResponse(meal).isActive).toBe(false);
    });
    it('attendanceEnabled is independent of isActive', () => {
      const meal = new MealEntity({ ...baseMeal, isActive: false, attendanceEnabled: true });
      const response = MealSerializer.toResponse(meal);
      expect(response.isActive).toBe(false);
      expect(response.attendanceEnabled).toBe(true);
    });
  });

  describe('attendanceWindow nesting (M-04 contract)', () => {
    it('nests attendanceWindow — never flattens to root', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.attendanceWindow).toEqual({ openTime: '06:00', closeTime: '09:00' });
      expect(response).not.toHaveProperty('attendanceWindowOpen');
      expect(response).not.toHaveProperty('attendanceWindowClose');
    });
    it('returns null attendanceWindow when not configured', () => {
      const meal = new MealEntity({ ...baseMeal, attendanceWindowOpen: null, attendanceWindowClose: null });
      expect(MealSerializer.toResponse(meal).attendanceWindow).toBeNull();
    });
    it('nested attendanceWindow has exactly openTime and closeTime', () => {
      const aw = MealSerializer.toResponse(baseMeal).attendanceWindow as any;
      expect(Object.keys(aw)).toEqual(['openTime', 'closeTime']);
    });
  });

  describe('enabledPreferences field (locked — NOT preferences)', () => {
    it('exposes enabledPreferences, never preferences', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response).toHaveProperty('enabledPreferences', ['veg', 'egg']);
      expect(response).not.toHaveProperty('preferences');
    });
    it('returns empty array when no preferences configured', () => {
      const meal = new MealEntity({ ...baseMeal, enabledPreferences: [] });
      const response = MealSerializer.toResponse(meal);
      expect(Array.isArray(response.enabledPreferences)).toBe(true);
      expect((response.enabledPreferences as string[]).length).toBe(0);
    });
  });

  describe('order field', () => {
    it('serializes order as integer', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.order).toBe(1);
      expect(typeof response.order).toBe('number');
    });
  });

  describe('field exposure', () => {
    it('exposes organizationId (part of the locked Meal contract)', () => {
      expect(MealSerializer.toResponse(baseMeal)).toHaveProperty('organizationId', 'org_01');
    });
    it('exposes groupId', () => {
      expect(MealSerializer.toResponse(baseMeal).groupId).toBe('grp_01');
    });
  });

  describe('timestamps', () => {
    it('serializes createdAt as ISO string', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(typeof response.createdAt).toBe('string');
    });
  });

  describe('Flutter contract — exact top-level keys', () => {
    it('produces all keys expected by Flutter MealModel.fromJson', () => {
      const response = MealSerializer.toResponse(baseMeal);
      const expectedKeys = [
        'id', 'groupId', 'organizationId', 'name', 'slotKey', 'order', 'isActive',
        'attendanceEnabled', 'preferencesEnabled', 'enabledPreferences',
        'description', 'menuItems', 'imageUrl', 'attendanceWindow', 'createdAt',
      ];
      expectedKeys.forEach((key) => expect(response).toHaveProperty(key));
    });
  });

  describe('toList', () => {
    it('serializes array of meals correctly', () => {
      const meals = [baseMeal, new MealEntity({ ...baseMeal, id: 'meal_02', slotKey: 'lunch', order: 2 })];
      const result = MealSerializer.toList(meals);
      expect(result).toHaveLength(2);
      expect(result[0].slotKey).toBe('breakfast');
      expect(result[1].slotKey).toBe('lunch');
    });
  });
});
