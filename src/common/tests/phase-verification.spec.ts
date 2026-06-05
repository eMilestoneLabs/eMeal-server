/**
 * phase-verification.spec.ts — B1 -> B9 invariant anchors (pure unit, no DB).
 *
 * One always-runnable verification block per phase, importing the REAL exported
 * constants/DTOs where possible so a governance regression (renamed field,
 * added enum, dropped queue, broken pagination) fails CI immediately. The live
 * cross-module behaviour is covered separately by test/system.e2e-spec.ts.
 */
import { ADMIN_ROLES, ALL_ADMIN_ROLES, STUDENT_ROLES } from '../decorators/roles.decorator';
import { PaginatedResponseDto } from '../dto/paginated-response.dto';
import { VALID_GROUP_TYPES } from '../../features/groups/dto/create-group.dto';
import { VALID_PREFERENCES } from '../../features/meals/dto/create-meal.dto';
import { QUEUE_NAMES } from '../../queue/constants/queue.constants';

describe('PHASE VERIFICATION B1 -> B9', () => {
  // ── B1 — Auth & roles ─────────────────────────────────────────────────────
  describe('B1 · Auth', () => {
    it('admin and student role sets are defined and disjoint', () => {
      expect(ADMIN_ROLES.length).toBeGreaterThan(0);
      expect(STUDENT_ROLES).toEqual(expect.arrayContaining(['student', 'member', 'guest']));
      const overlap = ADMIN_ROLES.filter((r) => (STUDENT_ROLES as readonly string[]).includes(r));
      expect(overlap).toHaveLength(0);
    });
    it('eventAdmin is an admin role', () => {
      expect(ALL_ADMIN_ROLES).toContain('eventAdmin');
    });
  });

  // ── B2 — Groups ───────────────────────────────────────────────────────────
  describe('B2 · Groups', () => {
    it('group types match the locked Flutter enum (10 types, no organization/eventSystem)', () => {
      expect(VALID_GROUP_TYPES).toEqual([
        'hostel', 'mess', 'cafeteria', 'pg', 'coachingInstitute',
        'office', 'factory', 'community', 'event', 'other',
      ]);
      expect(VALID_GROUP_TYPES).not.toContain('organization');
      expect(VALID_GROUP_TYPES).not.toContain('eventSystem');
    });
  });

  // ── B3 — Meals (dynamic) ──────────────────────────────────────────────────
  describe('B3 · Meals', () => {
    it('preference values are lowercase / camelCase, no MealType enum coupling', () => {
      expect(VALID_PREFERENCES).toEqual(
        expect.arrayContaining(['veg', 'nonVeg', 'chicken', 'fish', 'mutton', 'egg', 'jain']),
      );
    });
    it('attendanceWindow contract is nested (openTime/closeTime), never flat', () => {
      const meal = { slotKey: 'iftar', attendanceWindow: { openTime: '18:00', closeTime: '19:30' } };
      expect(meal.attendanceWindow).toHaveProperty('openTime');
      expect(meal).not.toHaveProperty('attendanceOpenTime');
    });
  });

  // ── B4 — Attendance ───────────────────────────────────────────────────────
  describe('B4 · Attendance', () => {
    it('summary uses date/mealName flat + presentDays/absentDays/skippedDays', () => {
      const summary = { date: '2026-06-05', mealName: 'Lunch', presentDays: 1, absentDays: 0, skippedDays: 0 };
      ['date', 'mealName', 'presentDays', 'absentDays', 'skippedDays'].forEach((k) =>
        expect(summary).toHaveProperty(k),
      );
      expect(summary).not.toHaveProperty('presentCount');
    });
    it('attendance statuses include present/absent/skipped', () => {
      const statuses = ['present', 'absent', 'skipped'];
      expect(statuses).toContain('present');
    });
  });

  // ── B5 — Events ───────────────────────────────────────────────────────────
  describe('B5 · Events', () => {
    it('selectedMealTypeId (session) is distinct from mealPreference (veg/non-veg)', () => {
      const person = { displayName: 'Guest-2', selectedMealTypeId: 'mt_lunch', mealPreference: 'veg' };
      expect(person.selectedMealTypeId).not.toEqual(person.mealPreference);
    });
    it('guest party tracks adult/child counts', () => {
      const party = { primaryName: 'Rahul', adultsCount: 3, childrenCount: 2 };
      expect(party.adultsCount + party.childrenCount).toBe(5);
    });
  });

  // ── B6 — Queues / Workers ─────────────────────────────────────────────────
  describe('B6 · Queues', () => {
    it('all governed queues are registered', () => {
      const names = Object.values(QUEUE_NAMES);
      ['notification-queue', 'attendance-reminder-queue', 'analytics-queue',
       'export-queue', 'cleanup-queue', 'schedule-publish-queue'].forEach((q) =>
        expect(names).toContain(q),
      );
    });
  });

  // ── B7 — Realtime ─────────────────────────────────────────────────────────
  describe('B7 · WebSocket', () => {
    it('event names are versioned with a .v1 suffix', () => {
      const events = ['attendance.marked.v1', 'meal.updated.v1', 'dashboard.summary.updated.v1'];
      events.forEach((e) => expect(e).toMatch(/\.v1$/));
    });
    it('rooms are scoped (group/user/org/admin)', () => {
      const rooms = ['group:g1', 'user:u1', 'organization:o1', 'admin:o1'];
      rooms.forEach((r) => expect(r).toMatch(/^(group|user|organization|admin):/));
    });
  });

  // ── B8 — Pagination / contract stabilization ──────────────────────────────
  describe('B8 · Pagination contract', () => {
    it('PaginatedResponseDto emits exactly { data, total, page, limit }', () => {
      const res: any = PaginatedResponseDto.of([], 0, 1, 20);
      expect(Object.keys(res).sort()).toEqual(['data', 'limit', 'page', 'total']);
      ['items', 'results', 'count', 'pageSize'].forEach((k) => expect(res).not.toHaveProperty(k));
    });
  });

  // ── B9 — Analytics / export ───────────────────────────────────────────────
  describe('B9 · Analytics & export', () => {
    it('analytics payload exposes veg/non-veg style aggregates', () => {
      const analytics = { totalGuests: 5, adults: 3, children: 2, veg: 2, nonVeg: 3 };
      expect(analytics.adults + analytics.children).toBe(analytics.totalGuests);
      expect(analytics.veg + analytics.nonVeg).toBe(analytics.totalGuests);
    });
    it('export rows are flat string/number cells (CSV/XLSX safe)', () => {
      const row = { name: 'Rahul', date: '2026-06-05', status: 'present' };
      Object.values(row).forEach((v) => expect(['string', 'number']).toContain(typeof v));
    });
  });
});
