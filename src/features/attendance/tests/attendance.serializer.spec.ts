import { AttendanceSerializer, AttendanceSummarySerializer } from '../serializers/attendance.serializer';
import { AttendanceEntity, AttendanceSummaryEntity } from '../entities/attendance.entity';

/**
 * AttendanceSerializer contract tests — verifies exact Flutter JSON shape.
 *
 * Verified against lib/shared/models/attendance_model.dart (AttendanceModel.fromJson).
 *
 * Key invariants (BUG-004 fixes applied 2026-06-01):
 *   - date: YYYY-MM-DD string (Flutter reads json['date'] NOT json['attendanceDate'])
 *   - mealName: FLAT string field (Flutter reads json['mealName'] — no nested meal object)
 *   - NO organizationId exclusion — Flutter DOES read json['organizationId']
 *   - status: raw string value
 *   - AttendanceSummary: presentDays/absentDays/skippedDays (NOT presentCount/etc)
 */
describe('AttendanceSerializer', () => {
  const baseRecord = new AttendanceEntity({
    id: 'att_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    userId: 'usr_01',
    mealId: 'meal_01',
    attendanceDate: new Date('2026-01-05T00:00:00.000Z'), // UTC midnight
    status: 'present',
    preference: 'veg',
    note: null,
    markedAt: new Date('2026-01-05T07:30:00.000Z'),
    markedBy: null,
    createdAt: new Date('2026-01-05T07:30:00.000Z'),
    updatedAt: new Date('2026-01-05T07:30:00.000Z'),
    meal: {
      slotKey: 'breakfast',
      name: 'Morning Meal',
      displayName: 'Breakfast',
      attendanceWindowOpen: '06:00',
      attendanceWindowClose: '09:00',
    },
  });

  // ── date field — YYYY-MM-DD only ─────────────────────────────────────────
  // Flutter AttendanceModel.fromJson reads json['date'] (NOT json['attendanceDate']).

  describe('date serialization', () => {
    it('must be YYYY-MM-DD string at key "date" — Flutter reads json[\'date\']', () => {
      const response = AttendanceSerializer.toResponse(baseRecord) as any;
      expect(response.date).toBe('2026-01-05');
      expect(typeof response.date).toBe('string');
      expect(response.date).not.toContain('T');
    });

    it('must NOT expose "attendanceDate" key — Flutter does not read it', () => {
      const response = AttendanceSerializer.toResponse(baseRecord) as any;
      // Flutter reads json['date'], not json['attendanceDate']
      expect(response.attendanceDate).toBeUndefined();
    });

    it('date must be a string, not a Date object', () => {
      const response = AttendanceSerializer.toResponse(baseRecord) as any;
      expect(response.date instanceof Date).toBe(false);
    });
  });

  // ── mealName — flat string field ─────────────────────────────────────────
  // Flutter AttendanceModel.fromJson reads json['mealName'] (flat string, not nested meal object).

  describe('mealName (flat field — M-10 contract)', () => {
    it('must include flat mealName when meal is joined (Flutter reads json[\'mealName\'])', () => {
      const response = AttendanceSerializer.toResponse(baseRecord) as any;
      expect(response.mealName).toBe('Breakfast');
      expect(typeof response.mealName).toBe('string');
    });

    it('must NOT expose nested meal object — Flutter model has no meal field', () => {
      const response = AttendanceSerializer.toResponse(baseRecord) as any;
      // Flutter AttendanceModel.fromJson has no json['meal'] — only json['mealName']
      expect(response.meal).toBeUndefined();
    });

    it('mealName falls back to meal.name when displayName is null', () => {
      const record = new AttendanceEntity({
        ...baseRecord,
        meal: {
          slotKey: 'dinner',
          name: 'Evening Meal',
          displayName: null,
          attendanceWindowOpen: null,
          attendanceWindowClose: null,
        },
      });
      const response = AttendanceSerializer.toResponse(record) as any;
      expect(response.mealName).toBe('Evening Meal');
    });

    it('mealName is empty string when meal is not joined', () => {
      const record = new AttendanceEntity({ ...baseRecord, meal: null });
      const response = AttendanceSerializer.toResponse(record) as any;
      expect(response.mealName).toBe('');
    });
  });

  // ── Field exposure rules ──────────────────────────────────────────────────

  describe('field exposure (B4 Flutter contract)', () => {
    it('must NOT expose markedByAdmin (removed in B4)', () => {
      const response = AttendanceSerializer.toResponse(baseRecord);
      expect(response).not.toHaveProperty('markedByAdmin');
    });

    it('must NOT expose adminId (removed in B4)', () => {
      const response = AttendanceSerializer.toResponse(baseRecord);
      expect(response).not.toHaveProperty('adminId');
    });

    it('must expose markedBy (nullable string)', () => {
      const response = AttendanceSerializer.toResponse(baseRecord) as any;
      expect(response).toHaveProperty('markedBy');
      expect(response.markedBy).toBeNull();
    });

    it('markedBy contains adminUserId when admin override', () => {
      const record = new AttendanceEntity({ ...baseRecord, markedBy: 'admin_01' });
      const response = AttendanceSerializer.toResponse(record) as any;
      expect(response.markedBy).toBe('admin_01');
    });
  });

  // ── Required Flutter contract keys ────────────────────────────────────────
  // Verified from Flutter AttendanceModel.fromJson constructor parameters.

  describe('Flutter contract — required top-level keys', () => {
    it('must include all required keys that Flutter reads', () => {
      const response = AttendanceSerializer.toResponse(baseRecord);
      // Keys Flutter's fromJson reads (verified from attendance_model.dart)
      const requiredKeys = [
        'id', 'groupId', 'userId', 'mealId', 'organizationId',
        'date', 'status', 'preference', 'note',
        'markedAt', 'markedBy', 'mealName', 'createdAt', 'updatedAt',
      ];
      requiredKeys.forEach((key) => {
        expect(response).toHaveProperty(key);
      });
    });
  });

  // ── toMarkResponse — lightweight response for POST /attendance ────────────

  describe('toMarkResponse (POST /attendance response)', () => {
    it('includes minimal fields with "date" key (not "attendanceDate")', () => {
      const response = AttendanceSerializer.toMarkResponse(baseRecord) as any;
      expect(response).toHaveProperty('id');
      expect(response).toHaveProperty('mealId');
      // Flutter reads json['date'] — confirmed from attendance_model.dart
      expect(response).toHaveProperty('date', '2026-01-05');
      expect(response).toHaveProperty('status', 'present');
      expect(response).toHaveProperty('preference', 'veg');
    });
  });
});

// ─── AttendanceSummarySerializer ─────────────────────────────────────────────
// Verified against Flutter AttendanceSummary.fromJson in attendance_model.dart.
// Flutter reads: totalDays, presentDays, absentDays, skippedDays.

describe('AttendanceSummarySerializer', () => {
  const baseSummary = new AttendanceSummaryEntity({
    userId: 'usr_01',
    groupId: 'grp_01',
    organizationId: 'org_01',
    fromDate: '2026-01-01',
    toDate: '2026-01-31',
    totalDays: 10,
    presentCount: 7,
    absentCount: 2,
    skippedCount: 1,
    onVacationCount: 0,
  });

  describe('NO rates or percentages (Flutter computes them)', () => {
    it('must NOT expose attendanceRate', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary);
      expect(response).not.toHaveProperty('attendanceRate');
    });

    it('must NOT expose presentRate', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary);
      expect(response).not.toHaveProperty('presentRate');
    });

    it('must NOT expose percentage', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary);
      expect(response).not.toHaveProperty('percentage');
    });
  });

  describe('raw counts must use Flutter field names (presentDays/absentDays/skippedDays)', () => {
    it('exposes presentDays — Flutter reads json[\'presentDays\']', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.presentDays).toBe(7);
    });

    it('exposes absentDays — Flutter reads json[\'absentDays\']', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.absentDays).toBe(2);
    });

    it('exposes skippedDays — Flutter reads json[\'skippedDays\']', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.skippedDays).toBe(1);
    });

    it('exposes totalDays', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.totalDays).toBe(10);
    });

    it('must NOT expose presentCount (entity field name — wrong for Flutter)', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.presentCount).toBeUndefined();
    });

    it('must NOT expose absentCount (entity field name — wrong for Flutter)', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.absentCount).toBeUndefined();
    });

    it('must NOT expose skippedCount (entity field name — wrong for Flutter)', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.skippedCount).toBeUndefined();
    });

    it('includes fromDate and toDate as strings', () => {
      const response = AttendanceSummarySerializer.toResponse(baseSummary) as any;
      expect(response.fromDate).toBe('2026-01-01');
      expect(response.toDate).toBe('2026-01-31');
    });
  });
});
