import { SchedulesService } from '../schedules.service';

/**
 * Live-Test-16 — guards for the three defects the adversarial audit found in
 * the FIRST cut of this batch. Each test was mutation-verified.
 *
 *   H1  the first-publish stamp ran BEFORE the realtime emit + today-cache
 *       invalidation and was not fail-soft, so a stamp failure aborted both on
 *       an ALREADY-COMMITTED publish and reported failure to the admin.
 *   M2  an Attendance-Only group could be stamped (it keeps weeklyMenuEnabled
 *       from a previous meals-ON life), inventing a lock with no meaning.
 *   M1  a non-replacing PATCH validated only the payload's entries, so a
 *       direct API call could persist a draft conflicting with rows it never
 *       mentioned.
 */
describe('Live-Test-16 — publish stamp + merge validation', () => {
  const makeService = (over: {
    group?: Record<string, any> | null;
    markImpl?: jest.Mock;
    entries?: any[];
  }) => {
    const mark =
      over.markImpl ?? jest.fn().mockResolvedValue(true);
    // Shaped for ScheduleSerializer.toResponse (needs organizationId,
    // isPublished, publishedAt, createdAt and weekStart).
    const published = {
      id: 'sch_01',
      groupId: 'grp_01',
      organizationId: 'org_01',
      weekStart: new Date('2026-08-03T00:00:00.000Z'),
      isPublished: true,
      publishedAt: new Date('2026-08-03T10:00:00.000Z'),
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      entries: over.entries ?? [],
    };
    const schedulesRepo: any = {
      findById: jest.fn().mockResolvedValue(published),
      findStaleEntries: jest.fn().mockResolvedValue([]),
      deleteEntriesByIds: jest.fn(),
      publish: jest.fn().mockResolvedValue(published),
      update: jest.fn().mockResolvedValue(published),
    };
    const groupsRepo: any = {
      findByIdConfig: jest.fn().mockResolvedValue(
        over.group === undefined
          ? { id: 'grp_01', mealsEnabled: true, mealPricingEnabled: true }
          : over.group,
      ),
      markFirstSchedulePublished: mark,
    };
    const mealsRepo: any = {
      findByGroup: jest.fn().mockResolvedValue({ data: [] }),
    };
    const audit: any = { log: jest.fn() };
    const realtime: any = {
      emitSchedulePublished: jest.fn(),
      emitScheduleUpdated: jest.fn(),
    };
    const redis: any = { del: jest.fn(), keys: jest.fn().mockResolvedValue([]) };
    const service = new SchedulesService(
      schedulesRepo,
      mealsRepo,
      groupsRepo,
      audit,
      realtime,
      redis,
      null as any,
    );
    return { service, schedulesRepo, groupsRepo, mealsRepo, realtime, mark };
  };

  const publish = (s: SchedulesService) =>
    s.publishSchedule('sch_01', 'org_01', 'usr_admin', 'req_1');

  it('M2: an Attendance-Only group is NEVER stamped (no meaningless lock)', async () => {
    const { service, mark } = makeService({
      group: { id: 'grp_01', mealsEnabled: false, mealPricingEnabled: false },
    });

    await publish(service);

    expect(mark).not.toHaveBeenCalled();
  });

  it('stamps a Meal-Enabled group exactly once', async () => {
    const { service, mark } = makeService({});

    await publish(service);

    expect(mark).toHaveBeenCalledWith('grp_01', 'org_01');
  });

  it('never re-stamps an already-locked group (idempotent re-publish)', async () => {
    const { service, mark } = makeService({
      group: {
        id: 'grp_01',
        mealsEnabled: true,
        firstSchedulePublishedAt: new Date('2026-07-01'),
      },
    });

    await publish(service);

    expect(mark).not.toHaveBeenCalled();
  });

  it('H1: a stamp FAILURE never fails an already-committed publish', async () => {
    const { service, realtime } = makeService({
      markImpl: jest.fn().mockRejectedValue(new Error('db down')),
    });

    // The publish resolves — the week IS live, so it must not report failure.
    await expect(publish(service)).resolves.toBeDefined();
    // And the side-effects students depend on still ran.
    expect(realtime.emitSchedulePublished).toHaveBeenCalled();
  });

  it('H1: the realtime emit happens BEFORE the stamp (ordering is load-bearing)', async () => {
    const order: string[] = [];
    const mark = jest.fn().mockImplementation(async () => {
      order.push('stamp');
      return true;
    });
    const { service, realtime } = makeService({ markImpl: mark });
    realtime.emitSchedulePublished.mockImplementation(() =>
      order.push('emit'),
    );

    await publish(service);

    expect(order).toEqual(['emit', 'stamp']);
  });

  it('M1: a non-replacing PATCH validates the SURVIVING rows too', async () => {
    // Persisted: Breakfast 07:00–09:00 on 2026-08-03.
    const persisted = [
      {
        mealId: 'meal_bf',
        date: new Date('2026-08-03T00:00:00.000Z'),
        openTime: null,
        closeTime: null,
        meal: {
          slotKey: 'breakfast',
          name: 'Breakfast',
          attendanceWindowOpen: '07:00',
          attendanceWindowClose: '09:00',
        },
      },
    ];
    const { service, mealsRepo } = makeService({ entries: persisted });
    mealsRepo.findByGroup.mockResolvedValue({
      data: [
        {
          id: 'meal_bf',
          name: 'Breakfast',
          slotKey: 'breakfast',
          isActive: true,
          attendanceWindowOpen: '07:00',
          attendanceWindowClose: '09:00',
        },
        {
          id: 'meal_ln',
          name: 'Lunch',
          slotKey: 'lunch',
          isActive: true,
          attendanceWindowOpen: '12:00',
          attendanceWindowClose: '14:00',
        },
      ],
    });

    // Payload mentions ONLY Lunch, at 09:30 — conflicts with the persisted
    // Breakfast it never mentions. replaceEntries omitted ⇒ merge.
    await expect(
      service.updateSchedule('sch_01', 'org_01', 'usr_admin', {
        entries: [
          {
            mealId: 'meal_ln',
            date: '2026-08-03',
            attendanceWindow: { openTime: '09:30', closeTime: '11:30' },
          },
        ],
      } as any),
    ).rejects.toMatchObject({ response: { code: 'MEAL_WINDOW_CONFLICT' } });
  });

  // ── Multi-tenant adversarial (§10) ─────────────────────────────────────────
  // Every NEW db operation this batch introduced must carry the CALLER's
  // organizationId, so tenant B can never stamp — or read the windows of —
  // tenant A's group. The repositories put organizationId in the WHERE, so
  // proving the argument propagates proves the isolation end to end.
  it('TENANT: the stamp is scoped to the CALLING org, never another tenant', async () => {
    const { service, mark } = makeService({});

    await service.publishSchedule('sch_01', 'org_TENANT_B', 'usr_admin');

    expect(mark).toHaveBeenCalledWith('grp_01', 'org_TENANT_B');
    expect(mark).not.toHaveBeenCalledWith('grp_01', 'org_01');
  });

  it('TENANT: the group load for publish is scoped to the CALLING org', async () => {
    const { service, groupsRepo } = makeService({});

    await service.publishSchedule('sch_01', 'org_TENANT_B', 'usr_admin');

    expect(groupsRepo.findByIdConfig).toHaveBeenCalledWith(
      'grp_01',
      'org_TENANT_B',
    );
  });

  it('TENANT: the window catalogue read is scoped to the CALLING org', async () => {
    const { service, mealsRepo } = makeService({});

    await service.updateSchedule('sch_01', 'org_TENANT_B', 'usr_admin', {
      replaceEntries: true,
      entries: [],
    } as any);

    // buildEntryData -> mealCatalogue -> findByGroup(groupId, organizationId)
    expect(mealsRepo.findByGroup).toHaveBeenCalledWith(
      'grp_01',
      'org_TENANT_B',
      expect.anything(),
    );
  });

  it('M1: replaceEntries=true still validates ONLY the payload (no false conflict)', async () => {
    const persisted = [
      {
        mealId: 'meal_bf',
        date: new Date('2026-08-03T00:00:00.000Z'),
        openTime: null,
        closeTime: null,
        meal: {
          slotKey: 'breakfast',
          name: 'Breakfast',
          attendanceWindowOpen: '07:00',
          attendanceWindowClose: '09:00',
        },
      },
    ];
    const { service, mealsRepo } = makeService({ entries: persisted });
    mealsRepo.findByGroup.mockResolvedValue({
      data: [
        {
          id: 'meal_ln',
          name: 'Lunch',
          slotKey: 'lunch',
          isActive: true,
          attendanceWindowOpen: '12:00',
          attendanceWindowClose: '14:00',
        },
      ],
    });

    // A full replace wipes Breakfast, so 09:30 is legal.
    await expect(
      service.updateSchedule('sch_01', 'org_01', 'usr_admin', {
        replaceEntries: true,
        entries: [
          {
            mealId: 'meal_ln',
            date: '2026-08-03',
            attendanceWindow: { openTime: '09:30', closeTime: '11:30' },
          },
        ],
      } as any),
    ).resolves.toBeDefined();
  });
});
