import { GroupSerializer } from '../serializers/group.serializer';
import { GroupEntity } from '../entities/group.entity';

/**
 * GroupSerializer contract tests — verifies exact Flutter JSON shape.
 *
 * These tests are the FIRST LINE of defense against contract regressions.
 * If any test fails, do NOT merge — the Flutter app will break.
 *
 * Contract source: lib/shared/models/group_model.dart (GroupModel.fromJson)
 */
describe('GroupSerializer', () => {
  const baseGroup = new GroupEntity({
    id: 'grp_01',
    organizationId: 'org_01',
    name: 'Boys Block A',
    type: 'hostel',
    description: 'Ground floor',
    adminId: 'usr_01',
    joinToken: 'HTL3K8XZ',         // internal DB field
    joinTokenExpiresAt: null,
    maxMembers: 100,
    isActive: true,
    mealsEnabled: true,
    weeklyMenuEnabled: true,
    preferencesEnabled: true,
    enabledPreferences: ['veg', 'chicken', 'egg'],
    vacationModeEnabled: true,
    memberCount: 3,
    memberIds: ['usr_01', 'usr_02', 'usr_03'],
    blockedMemberIds: ['usr_04'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  describe('joinCode field (M-06 contract fix)', () => {
    it('must expose joinCode, NOT joinToken', () => {
      const response = GroupSerializer.toResponse(baseGroup);
      expect(response).toHaveProperty('joinCode', 'HTL3K8XZ');
      expect(response).not.toHaveProperty('joinToken');
    });
  });

  describe('mealConfig nesting (M-07 contract fix)', () => {
    it('must nest mealConfig as object — never flatten to root', () => {
      const response = GroupSerializer.toResponse(baseGroup);
      expect(response.mealConfig).toBeDefined();
      expect(typeof response.mealConfig).toBe('object');

      // mealConfig fields must be INSIDE the object, not at root
      expect(response).not.toHaveProperty('mealsEnabled');
      expect(response).not.toHaveProperty('weeklyMenuEnabled');
      expect(response).not.toHaveProperty('preferencesEnabled');
      expect(response).not.toHaveProperty('vacationModeEnabled');
    });

    it('must include all 5 mealConfig fields with correct values', () => {
      const response = GroupSerializer.toResponse(baseGroup);
      const mc = response.mealConfig as any;

      expect(mc.mealsEnabled).toBe(true);
      expect(mc.weeklyMenuEnabled).toBe(true);
      expect(mc.preferencesEnabled).toBe(true);
      expect(mc.enabledPreferences).toEqual(['veg', 'chicken', 'egg']);
      expect(mc.vacationModeEnabled).toBe(true);
    });

    it('must always include mealConfig even when meals are disabled', () => {
      const disabledMeals = new GroupEntity({
        ...baseGroup,
        mealsEnabled: false,
        weeklyMenuEnabled: false,
        preferencesEnabled: false,
        enabledPreferences: [],
      });
      const response = GroupSerializer.toResponse(disabledMeals);

      // mealConfig must always be present — Flutter renders conditionally based on it
      expect(response.mealConfig).toBeDefined();
      const mc = response.mealConfig as any;
      expect(mc.mealsEnabled).toBe(false);
      expect(mc.weeklyMenuEnabled).toBe(false);
    });
  });

  describe('computed membership fields', () => {
    it('must include memberCount, memberIds, blockedMemberIds', () => {
      const response = GroupSerializer.toResponse(baseGroup);
      expect(response.memberCount).toBe(3);
      expect(response.memberIds).toEqual(['usr_01', 'usr_02', 'usr_03']);
      expect(response.blockedMemberIds).toEqual(['usr_04']);
    });

    it('must return empty arrays (not null) when no members', () => {
      const emptyGroup = new GroupEntity({
        ...baseGroup,
        memberCount: 0,
        memberIds: [],
        blockedMemberIds: [],
      });
      const response = GroupSerializer.toResponse(emptyGroup);
      expect(Array.isArray(response.memberIds)).toBe(true);
      expect(Array.isArray(response.blockedMemberIds)).toBe(true);
      expect(response.memberCount).toBe(0);
    });
  });

  describe('GroupType enum contract (M-05 fix)', () => {
    const validTypes = [
      'hostel', 'mess', 'cafeteria', 'pg', 'coachingInstitute',
      'office', 'factory', 'community', 'event', 'other',
    ];

    it.each(validTypes)('serializes GroupType "%s" (factory -> factory_ per BUG-002)', (type) => {
      const group = new GroupEntity({ ...baseGroup, type });
      const response = GroupSerializer.toResponse(group);
      const expected = type === 'factory' ? 'factory_' : type;
      expect(response.type).toBe(expected);
    });

    it('never emits "organization" or "eventSystem" for any valid type', () => {
      validTypes.forEach((type) => {
        const group = new GroupEntity({ ...baseGroup, type });
        const response = GroupSerializer.toResponse(group);
        expect(['organization', 'eventSystem']).not.toContain(response.type);
      });
    });
  });

  describe('null safety', () => {
    it('must return null for optional fields when not set', () => {
      const minimalGroup = new GroupEntity({
        id: 'grp_02',
        organizationId: 'org_01',
        name: 'Minimal Group',
        type: 'mess',
        isActive: true,
        joinToken: 'MINIMAL1',
        mealsEnabled: true,
        weeklyMenuEnabled: false,
        preferencesEnabled: false,
        enabledPreferences: [],
        vacationModeEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const response = GroupSerializer.toResponse(minimalGroup);
      expect(response.description).toBeNull();
      expect(response.adminId).toBeNull();
    });
  });

  describe('timestamps', () => {
    it('must serialize createdAt as ISO string', () => {
      const response = GroupSerializer.toResponse(baseGroup);
      expect(response.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(typeof response.createdAt).toBe('string');
    });
  });

  describe('exact Flutter contract shape', () => {
    it('must produce exact top-level keys expected by Flutter GroupModel.fromJson', () => {
      const response = GroupSerializer.toResponse(baseGroup);
      const expectedKeys = [
        'id', 'organizationId', 'name', 'type', 'description',
        'adminId', 'isActive', 'joinCode', 'memberCount',
        'memberIds', 'blockedMemberIds', 'mealConfig', 'createdAt',
      ];
      expectedKeys.forEach((key) => {
        expect(response).toHaveProperty(key);
      });
    });
  });
});
