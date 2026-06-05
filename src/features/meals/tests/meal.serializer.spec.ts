import { MealSerializer } from '../serializers/meal.serializer';
import { MealEntity } from '../entities/meal.entity';

/**
 * MealSerializer contract tests — verifies exact Flutter JSON shape.
 *
 * These tests are the FIRST LINE of defense against B3 contract regressions.
 * If any test fails, do NOT merge — the Flutter app will break.
 *
 * Contract source: lib/features/meals/models/meal_model.dart (MealModel.fromJson)
 *
 * Key invariants:
 *   - slotKey is ALWAYS free-form string (never enum)
 *   - isActive → isEnabled (renamed in serializer)
 *   - enabledPreferences → preferences (renamed in serializer)
 *   - attendanceWindow ALWAYS nested { openTime, closeTime } | null
 *   - displayName falls back to name when null
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

  // ── slotKey — NEVER enum ────────────────────────────────────────────────

  describe('slotKey contract (dynamic rendering architecture)', () => {
    it('passes through slotKey as-is — never hardcoded', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.slotKey).toBe('breakfast');
    });

    it.each(['lunch', 'dinner', 'iftar', 'sehri', 'high-tea', 'midnightMeal', 'customSlot'])(
      'serializes arbitrary slotKey "%s" correctly',
      (slotKey) => {
        const meal = new MealEntity({ ...baseMeal, slotKey });
        const response = MealSerializer.toResponse(meal);
        expect(response.slotKey).toBe(slotKey);
      },
    );
  });

  // ── displayName fallback ────────────────────────────────────────────────

  describe('displayName fallback (B3 contract)', () => {
    it('uses displayName when set', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.displayName).toBe('Breakfast');
    });

    it('falls back to name when displayName is null', () => {
      const meal = new MealEntity({ ...baseMeal, displayName: null });
      const response = MealSerializer.toResponse(meal);
      expect(response.displayName).toBe('Morning Meal');
    });
  });

  // ── isActive → isEnabled rename ────────────────────────────────────────

  describe('isEnabled field (isActive → isEnabled rename)', () => {
    it('must expose isEnabled NOT isActive', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response).toHaveProperty('isEnabled', true);
      expect(response).not.toHaveProperty('isActive');
    });

    it('isEnabled=false when meal is soft-deleted', () => {
      const disabled = new MealEntity({ ...baseMeal, isActive: false });
      const response = MealSerializer.toResponse(disabled);
      expect(response.isEnabled).toBe(false);
    });

    it('attendanceEnabled is independent of isEnabled', () => {
      // Meal hidden but attendance still enabled — valid state
      const meal = new MealEntity({ ...baseMeal, isActive: false, attendanceEnabled: true });
      const response = MealSerializer.toResponse(meal);
      expect(response.isEnabled).toBe(false);
      expect(response.attendanceEnabled).toBe(true);
    });
  });

  // ── attendanceWindow — ALWAYS nested ───────────────────────────────────

  describe('attendanceWindow nesting (M-04 contract fix)', () => {
    it('must nest attendanceWindow — never flatten to root', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.attendanceWindow).toEqual({ openTime: '06:00', closeTime: '09:00' });
      expect(response).not.toHaveProperty('attendanceWindowOpen');
      expect(response).not.toHaveProperty('attendanceWindowClose');
    });

    it('returns null attendanceWindow when not configured', () => {
      const meal = new MealEntity({
        ...baseMeal,
        attendanceWindowOpen: null,
        attendanceWindowClose: null,
      });
      const response = MealSerializer.toResponse(meal);
      expect(response.attendanceWindow).toBeNull();
    });

    it('nested attendanceWindow has exactly openTime and closeTime', () => {
      const response = MealSerializer.toResponse(baseMeal);
      const aw = response.attendanceWindow as any;
      expect(Object.keys(aw)).toEqual(['openTime', 'closeTime']);
    });
  });

  // ── preferences rename ─────────────────────────────────────────────────

  describe('preferences field (enabledPreferences → preferences rename)', () => {
    it('must expose preferences NOT enabledPreferences', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response).toHaveProperty('preferences', ['veg', 'egg']);
      expect(response).not.toHaveProperty('enabledPreferences');
    });

    it('returns empty array when no preferences configured', () => {
      const meal = new MealEntity({ ...baseMeal, enabledPreferences: [] });
      const response = MealSerializer.toResponse(meal);
      expect(Array.isArray(response.preferences)).toBe(true);
      expect((response.preferences as string[]).length).toBe(0);
    });
  });

  // ── order guarantee ────────────────────────────────────────────────────

  describe('order field', () => {
    it('serializes order as integer', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.order).toBe(1);
      expect(typeof response.order).toBe('number');
    });
  });

  // ── no organizationId in response (Flutter only needs groupId) ─────────

  describe('field exposure', () => {
    it('must NOT expose organizationId (groupId is sufficient for Flutter)', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response).not.toHaveProperty('organizationId');
    });

    it('must expose groupId', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.groupId).toBe('grp_01');
    });
  });

  // ── timestamps ────────────────────────────────────────────────────────

  describe('timestamps', () => {
    it('must serialize createdAt as ISO string', () => {
      const response = MealSerializer.toResponse(baseMeal);
      expect(response.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(typeof response.createdAt).toBe('string');
    });
  });

  // ── exact Flutter contract keys ────────────────────────────────────────

  describe('Flutter contract — exact top-level keys', () => {
    it('must produce all keys expected by Flutter MealModel.fromJson', () => {
      const response = MealSerializer.toResponse(baseMeal);
      const expectedKeys = [
        'id', 'groupId', 'slotKey', 'displayName', 'isEnabled',
        'attendanceEnabled', 'order', 'attendanceWindow', 'preferences',
        'preferencesEnabled', 'description', 'menuItems', 'imageUrl', 'createdAt',
      ];
      expectedKeys.forEach((key) => {
        expect(response).toHaveProperty(key);
      });
    });
  });

  // ── toList ────────────────────────────────────────────────────────────

  describe('toList', () => {
    it('serializes array of meals correctly', () => {
      const meals = [
        baseMeal,
        new MealEntity({ ...baseMeal, id: 'meal_02', slotKey: 'lunch', order: 2 }),
      ];
      const result = MealSerializer.toList(meals);
      expect(result).toHaveLength(2);
      expect(result[0].slotKey).toBe('breakfast');
      expect(result[1].slotKey).toBe('lunch');
    });
  });
});
