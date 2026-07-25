import { SchedulesRepository } from '../repositories/schedules.repository';

/**
 * ISSUE-001 (Live-Test-13) — PUBLISHED SCHEDULE INTEGRITY.
 *
 * Regression guard for a bug that came back across several sessions because
 * each fix only covered the `publishedSnapshot` path.
 *
 * The rule: deleting or DISABLING a master meal must NOT change what members
 * already see. Members keep the last PUBLISHED week until the admin reviews
 * the auto-draft and republishes — even when the schedule row predates the
 * `publishedSnapshot` column (snapshot null), which is the case for every week
 * published by an older build, i.e. real production data.
 *
 * The admin DRAFT view keeps the opposite behaviour (archived meals hidden, so
 * the planner reflects the deletion immediately) — both are asserted here so
 * neither side can be "fixed" into breaking the other.
 */
describe('ISSUE-001 published schedule integrity (archived master meals)', () => {
  /** A published week whose 2nd entry's master meal was archived after publish. */
  const legacyPublishedRow = (publishedSnapshot: unknown) => ({
    id: 'sch_01',
    organizationId: 'org_01',
    groupId: 'grp_01',
    weekStart: new Date('2026-07-20T00:00:00.000Z'),
    isPublished: false, // auto-drafted by the delete/disable trigger
    publishedAt: new Date('2026-07-19T10:00:00.000Z'),
    publishedSnapshot,
    createdAt: new Date('2026-07-19T09:00:00.000Z'),
    updatedAt: new Date('2026-07-24T09:00:00.000Z'),
    entries: [
      {
        id: 'e1', scheduleId: 'sch_01', mealId: 'meal_live', dayOfWeek: 0,
        date: new Date('2026-07-20T00:00:00.000Z'),
        meal: { id: 'meal_live', slotKey: 'breakfast', name: 'Breakfast', isActive: true },
      },
      {
        id: 'e2', scheduleId: 'sch_01', mealId: 'meal_archived', dayOfWeek: 0,
        date: new Date('2026-07-20T00:00:00.000Z'),
        meal: { id: 'meal_archived', slotKey: 'lunch', name: 'Lunch', isActive: false },
      },
    ],
  });

  const repoWith = (row: unknown) =>
    new SchedulesRepository({
      mealSchedule: {
        findFirst: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([row]),
        count: jest.fn().mockResolvedValue(1),
      },
    } as never);

  it('member view KEEPS an archived meal on a legacy (null-snapshot) published week', async () => {
    const repo = repoWith(legacyPublishedRow(null));
    const schedule = await repo.findPublishedForWeek(
      'grp_01', 'org_01', new Date('2026-07-20T00:00:00.000Z'),
    );
    expect(schedule!.entries.map((e) => e.mealId)).toEqual(
      expect.arrayContaining(['meal_live', 'meal_archived']),
    );
  });

  it('member view KEEPS an archived meal carried by a frozen snapshot', async () => {
    const snap = [
      { id: 'e1', scheduleId: 'sch_01', mealId: 'meal_live', dayOfWeek: 0, date: '2026-07-20T00:00:00.000Z' },
      { id: 'e2', scheduleId: 'sch_01', mealId: 'meal_archived', dayOfWeek: 0, date: '2026-07-20T00:00:00.000Z' },
    ];
    const repo = repoWith(legacyPublishedRow(snap));
    const schedule = await repo.findPublishedForWeek(
      'grp_01', 'org_01', new Date('2026-07-20T00:00:00.000Z'),
    );
    expect(schedule!.entries.map((e) => e.mealId)).toEqual(
      expect.arrayContaining(['meal_live', 'meal_archived']),
    );
  });

  it('admin DRAFT view still HIDES the archived meal (auto-draft reflects the deletion)', async () => {
    const repo = repoWith(legacyPublishedRow(null));
    const schedule = await repo.findById('sch_01', 'org_01');
    const ids = schedule!.entries.map((e) => e.mealId);
    expect(ids).toContain('meal_live');
    expect(ids).not.toContain('meal_archived');
  });
});
