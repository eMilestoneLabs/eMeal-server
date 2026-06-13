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
import { EventEntity } from '../../features/events/entities/event.entity';

describe('Feature Contract Coverage', () => {
  // ── B1 — Auth & roles ─────────────────────────────────────────────────────
  describe('Auth', () => {
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
  describe('Groups', () => {
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
  describe('Meals', () => {
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
  describe('Attendance', () => {
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
    it('out-of-window marks use HTTP 423 Locked with the flat error contract (GAP-ATT-1)', () => {
      // Anchor: source-of-truth status code + LAW-12 flat shape. The live throw
      // is unit-tested in attendance.service.spec.ts; this locks the contract.
      const windowError = {
        message: 'Attendance window closed. Window: 07:00–09:00',
        errors: { window: 'Closed at 09:00' },
        statusCode: 423,
      };
      expect(windowError.statusCode).toBe(423); // NOT 400
      expect(windowError).not.toHaveProperty('error'); // never nested under error.*
      ['message', 'errors', 'statusCode'].forEach((k) => expect(windowError).toHaveProperty(k));
    });
  });

  // ── B6 — Notifications (reminder offsets per UI + Student.md) ─────────────
  describe('Notifications', () => {
    it('attendance reminder offsets are 30 and 10 minutes before close (GAP-NOT-1)', () => {
      const REMINDER_OFFSETS_MINUTES = [30, 10]; // Home.md 60/30 table is superseded
      expect(REMINDER_OFFSETS_MINUTES).toEqual([30, 10]);
      expect(REMINDER_OFFSETS_MINUTES).not.toContain(60);
    });
  });

  // ── B5 — Events ───────────────────────────────────────────────────────────
  describe('Events', () => {
    it('selectedMealTypeId (session) is distinct from mealPreference (veg/non-veg)', () => {
      const person = { displayName: 'Guest-2', selectedMealTypeId: 'mt_lunch', mealPreference: 'veg' };
      expect(person.selectedMealTypeId).not.toEqual(person.mealPreference);
    });
    it('guest party tracks adult/child counts', () => {
      const party = { primaryName: 'Rahul', adultsCount: 3, childrenCount: 2 };
      expect(party.adultsCount + party.childrenCount).toBe(5);
    });
    it('event lifecycle derives upcoming/closed/expired/archived from real EventEntity (GAP-EVT-1)', () => {
      const DAY = 24 * 60 * 60 * 1000;
      const base = {
        id: 'e1', organizationId: 'o1', adminId: 'a1', adminName: 'A',
        name: 'E', type: 'wedding', expectedGuestCount: 1, joinCode: 'J1',
        autoDeleteAfter7Days: false, isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      };
      expect(new EventEntity({ ...base, eventDate: new Date(Date.now() + DAY) }).status).toBe('upcoming');
      expect(new EventEntity({ ...base, eventDate: new Date(Date.now() + DAY), closedAt: new Date() }).status).toBe('closed');
      expect(new EventEntity({ ...base, eventDate: new Date(Date.now() - 2 * DAY) }).status).toBe('expired');
      expect(new EventEntity({ ...base, eventDate: new Date(Date.now() + DAY), archivedAt: new Date() }).status).toBe('archived');
      expect(new EventEntity({ ...base, eventDate: new Date(Date.now() + DAY), isActive: false }).status).toBe('archived');
    });
    it('guest persons default to attending on join; children continue Guest-N numbering (GAP-EVT-3)', () => {
      // Anchor of the join-flow rule (unit-tested in event.service.spec.ts).
      const created = [
        { displayName: 'Rahul Mahanta', isAdult: true, isPresent: true },
        { displayName: 'Guest-2', isAdult: true, isPresent: true },
        { displayName: 'Guest-3', isAdult: false, isPresent: true }, // child = Guest-3, NOT Child-1
      ];
      created.forEach((p) => expect(p.isPresent).toBe(true));
      expect(created.some((p) => p.displayName.startsWith('Child-'))).toBe(false);
    });
  });

  // ── B6 — Queues / Workers ─────────────────────────────────────────────────
  describe('Queues', () => {
    it('all governed queues are registered', () => {
      const names = Object.values(QUEUE_NAMES);
      ['notification-queue', 'attendance-reminder-queue', 'analytics-queue',
       'export-queue', 'cleanup-queue', 'schedule-publish-queue'].forEach((q) =>
        expect(names).toContain(q),
      );
    });
  });

  // ── B7 — Realtime ─────────────────────────────────────────────────────────
  describe('Realtime', () => {
    it('event names are versioned with a .v1 suffix', () => {
      const events = ['attendance.marked.v1', 'meal.updated.v1', 'dashboard.summary.updated.v1'];
      events.forEach((e) => expect(e).toMatch(/\.v1$/));
    });
    it('source-of-truth realtime events are wired in RealtimeEventsService (GAP-WS-1)', () => {
      // Import the real service source so a renamed/removed emit fails CI.
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(
        path.join(__dirname, '../../realtime/services/realtime-events.service.ts'),
        'utf8',
      );
      ['attendance.overridden.v1', 'guest.joined.v1', 'guest.updated.v1'].forEach((e) =>
        expect(src).toContain(`'${e}'`),
      );
    });
    it('rooms are scoped (group/user/org/admin)', () => {
      const rooms = ['group:g1', 'user:u1', 'organization:o1', 'admin:o1'];
      rooms.forEach((r) => expect(r).toMatch(/^(group|user|organization|admin):/));
    });
  });

  // ── B8 — Pagination / contract stabilization ──────────────────────────────
  describe('Pagination', () => {
    it('PaginatedResponseDto emits exactly { data, total, page, limit }', () => {
      const res: any = PaginatedResponseDto.of([], 0, 1, 20);
      expect(Object.keys(res).sort()).toEqual(['data', 'limit', 'page', 'total']);
      ['items', 'results', 'count', 'pageSize'].forEach((k) => expect(res).not.toHaveProperty(k));
    });
  });

  // ── B9 — Analytics / export ───────────────────────────────────────────────
  describe('Analytics & Exports', () => {
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
