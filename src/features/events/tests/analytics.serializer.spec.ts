/**
 * analytics.serializer.spec.ts — B5 Phase
 *
 * Tests for AttendanceAnalyticsSerializer: contract shape, counts only,
 * no percentages, org scoping.
 */
import { AttendanceAnalyticsSerializer } from '../../dashboard/serializers/dashboard.serializer';
import { AttendanceAnalyticsEntity } from '../../dashboard/entities/dashboard.entity';

describe('AttendanceAnalyticsSerializer', () => {
  const entity = new AttendanceAnalyticsEntity({
    organizationId: 'org-1',
    groupId: 'group-1',
    fromDate: '2026-06-01',
    toDate: '2026-06-07',
    dailyBreakdown: [
      { date: '2026-06-01', present: 10, absent: 2, skipped: 1, onVacation: 0 },
    ],
    slotBreakdown: [
      { slotKey: 'breakfast', displayName: 'Breakfast', present: 10, absent: 2, skipped: 1 },
    ],
    totalMembers: 15,
    generatedAt: '2026-06-01T05:30:00.000Z',
  });

  it('should serialize to correct contract shape', () => {
    const result = AttendanceAnalyticsSerializer.toResponse(entity);

    expect(result).toHaveProperty('organizationId', 'org-1');
    expect(result).toHaveProperty('groupId', 'group-1');
    expect(result).toHaveProperty('fromDate', '2026-06-01');
    expect(result).toHaveProperty('toDate', '2026-06-07');
    expect(result).toHaveProperty('totalMembers', 15);
    expect(result).toHaveProperty('dailyBreakdown');
    expect(result).toHaveProperty('slotBreakdown');
    expect(result).toHaveProperty('generatedAt');
  });

  it('should NOT include percentages (Flutter computes)', () => {
    const result = AttendanceAnalyticsSerializer.toResponse(entity);
    expect(result).not.toHaveProperty('presentRate');
    expect(result).not.toHaveProperty('absentRate');
    expect(result).not.toHaveProperty('participationPercent');
  });

  it('slotKey should remain free-form string in breakdown', () => {
    const result = AttendanceAnalyticsSerializer.toResponse(entity) as any;
    expect(result.slotBreakdown[0].slotKey).toBe('breakfast');
  });
});
