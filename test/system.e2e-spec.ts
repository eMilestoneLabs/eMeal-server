/**
 * system.e2e-spec.ts — SYSTEM / INTEGRATION layer (phases B1 → B9).
 *
 * Exercises a real cross-module user journey against live Postgres + Redis:
 *
 *   B1 Auth        admin signup -> login -> /me -> refresh -> logout
 *   B2 Groups      create group -> fetch group (joinCode, nested mealConfig)
 *   B2 Pagination  list groups returns { data, total, page, limit }
 *   B3 Meals       create meal (free slotKey, nested attendanceWindow)
 *   B4 Attendance  positive mark + idempotent re-mark + 423 window lock
 *   B5 Events      create -> meal type -> guest join (isPresent=true, Guest-N)
 *                  -> 409 meal-type-in-use -> close -> 423 join lock
 *   NEG            invalid JWT, invalid join code, duplicate-safe re-mark
 *   TENANT         Org B cannot read Org A resources (multi-tenant isolation)
 *
 * Assertions favour HTTP-success ranges + contract-key presence (the things the
 * frontend is locked to) over exact computed values, so the suite is a stable
 * regression net rather than brittle.
 */
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp, uniq } from './utils/test-app';

const ok = (status: number) => expect([200, 201]).toContain(status);

describe('SYSTEM journey B1->B5 (e2e)', () => {
  let app: INestApplication;
  let http: any;

  const email = `admin_${uniq()}@example.com`;
  const password = 'Password123!';
  let accessToken = '';
  let refreshToken = '';
  let groupId = '';
  let openMealId = '';
  let eventId = '';
  let eventJoinCode = '';
  let mealTypeId = '';
  let guestPersonId = '';

  /** Today (YYYY-MM-DD) in the org default timezone (Asia/Kolkata). */
  const todayIst = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  /** HH:mm right now in IST — used to build open/closed windows deterministically. */
  const nowIst = () =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());

  beforeAll(async () => {
    app = await createTestApp();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  // ── B1: AUTH ────────────────────────────────────────────────────────────
  it('B1 · admin signup returns auth session (accessToken, refreshToken, user)', async () => {
    const res = await request(http).post('/api/v1/auth/signup/admin').send({
      name: 'Org Admin',
      role: 'organizationManager',
      email,
      password,
      organizationName: `Org ${uniq()}`,
    });
    ok(res.status);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body).toHaveProperty('expiresIn');
    expect(typeof res.body.expiresIn).toBe('number'); // M-02: integer seconds
    expect(res.body).toHaveProperty('user');
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it('B1 · login with identifier + password', async () => {
    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ identifier: email, password });
    ok(res.status);
    expect(res.body).toHaveProperty('accessToken');
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it('B1 · GET /me with bearer returns the user', async () => {
    const res = await request(http)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    ok(res.status);
    expect(res.body).toHaveProperty('id');
  });

  // ── B2: GROUPS ──────────────────────────────────────────────────────────
  it('B2 · create group returns joinCode + nested mealConfig', async () => {
    const res = await request(http)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `Mess ${uniq()}`, type: 'mess' });
    ok(res.status);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('joinCode');
    expect(res.body).not.toHaveProperty('joinToken'); // DB name must not leak
    expect(res.body).toHaveProperty('mealConfig');
    expect(res.body.mealConfig).toHaveProperty('mealsEnabled');
    groupId = res.body.id;
  });

  it('B2 · list groups follows the pagination contract', async () => {
    const res = await request(http)
      .get('/api/v1/groups')
      .set('Authorization', `Bearer ${accessToken}`);
    ok(res.status);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('limit');
    for (const forbidden of ['items', 'results', 'count', 'pageSize']) {
      expect(res.body).not.toHaveProperty(forbidden);
    }
  });

  // ── B3: MEALS ───────────────────────────────────────────────────────────
  it('B3 · create meal with free slotKey + nested attendanceWindow', async () => {
    const res = await request(http)
      .post('/api/v1/meals')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        groupId,
        slotKey: 'breakfast',
        name: 'Breakfast',
        attendanceWindow: { openTime: '07:00', closeTime: '09:00' },
      });
    ok(res.status);
    expect(res.body).toHaveProperty('slotKey', 'breakfast');
    expect(res.body).toHaveProperty('attendanceWindow');
    expect(res.body.attendanceWindow).toHaveProperty('openTime', '07:00');
    expect(res.body).not.toHaveProperty('attendanceOpenTime'); // never flattened
  });

  // ── B4: ATTENDANCE (positive + idempotent + 423 window lock) ─────────────
  it('B4 · mark attendance inside an open window (locked field names)', async () => {
    // Always-open window so the test is deterministic at any wall-clock time.
    const meal = await request(http)
      .post('/api/v1/meals')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        groupId,
        slotKey: 'lunch',
        name: 'Lunch',
        attendanceWindow: { openTime: '00:00', closeTime: '23:59' },
      });
    ok(meal.status);
    openMealId = meal.body.id;

    const res = await request(http)
      .post('/api/v1/attendance')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ mealId: openMealId, attendanceDate: todayIst(), status: 'present' });
    ok(res.status);
    expect(res.body).toHaveProperty('date');          // BUG-004: 'date', never attendanceDate
    expect(res.body).not.toHaveProperty('attendanceDate');
    expect(res.body).toHaveProperty('status', 'present');
  });

  it('B4 · re-marking the same meal/date is idempotent (update, never duplicate error)', async () => {
    const res = await request(http)
      .post('/api/v1/attendance')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ mealId: openMealId, attendanceDate: todayIst(), status: 'skipped' });
    ok(res.status);
    expect(res.body).toHaveProperty('status', 'skipped'); // upsert path
  });

  it('B4 · NEG: out-of-window mark is rejected with 423 Locked (GAP-ATT-1)', async () => {
    const closed = nowIst() >= '12:00'
      ? { openTime: '00:01', closeTime: '00:02' }
      : { openTime: '23:58', closeTime: '23:59' };
    const meal = await request(http)
      .post('/api/v1/meals')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ groupId, slotKey: 'high-tea', name: 'High Tea', attendanceWindow: closed });
    ok(meal.status);

    const res = await request(http)
      .post('/api/v1/attendance')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ mealId: meal.body.id, attendanceDate: todayIst(), status: 'present' });
    expect(res.status).toBe(423);
    expect(res.body).toHaveProperty('statusCode', 423); // flat error contract
    expect(String(res.body.message)).toContain('Attendance window closed');
  });

  // ── B5: EVENTS (lifecycle + guest flow + governance blocks) ──────────────
  it('B5 · create event returns joinCode + additive lifecycle status', async () => {
    const res = await request(http)
      .post('/api/v1/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: `Wedding ${uniq()}`,
        type: 'wedding',
        eventDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        expectedGuestCount: 50,
      });
    ok(res.status);
    expect(res.body).toHaveProperty('joinCode');
    expect(res.body).toHaveProperty('date');        // M-15: json['date']
    expect(res.body).toHaveProperty('status', 'upcoming'); // additive (GAP-EVT-1)
    eventId = res.body.id;
    eventJoinCode = res.body.joinCode;
  });

  it('B5 · event admin creates a meal type', async () => {
    const res = await request(http)
      .post(`/api/v1/events/${eventId}/meal-types`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Veg', emoji: '🥗', isVeg: true });
    ok(res.status);
    expect(res.body).toHaveProperty('title', 'Veg'); // M-14: title, never name
    mealTypeId = res.body.id;
  });

  it('B5 · guest joins via join code — party persons attending by default, Guest-N naming', async () => {
    const res = await request(http)
      .post('/api/v1/events/join')
      .send({ joinCode: eventJoinCode, primaryName: 'Rahul Mahanta', adultsCount: 2, childrenCount: 1 });
    ok(res.status);
    expect(res.body).toHaveProperty('primaryName', 'Rahul Mahanta');
    expect(res.body.persons).toHaveLength(3);
    for (const p of res.body.persons) expect(p.isPresent).toBe(true); // GAP-EVT-3
    const names = res.body.persons.map((p: any) => p.displayName);
    expect(names).toContain('Guest-2');
    expect(names).toContain('Guest-3'); // child continues Guest-N (never Child-1)
    expect(names.some((n: string) => n.startsWith('Child-'))).toBe(false);
    guestPersonId = res.body.persons[0].id;
  });

  it('B5 · NEG: deleting a selected meal type is blocked with 409 (GAP-EVT-2)', async () => {
    const sel = await request(http)
      .patch(`/api/v1/events/${eventId}/persons/${guestPersonId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ selectedMealTypeId: mealTypeId });
    ok(sel.status);

    const res = await request(http)
      .delete(`/api/v1/events/${eventId}/meal-types/${mealTypeId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toContain('guests have already selected');
  });

  it('B5 · close event → status=closed, further guest joins rejected with 423 (GAP-EVT-1)', async () => {
    const close = await request(http)
      .post(`/api/v1/events/${eventId}/close`)
      .set('Authorization', `Bearer ${accessToken}`);
    ok(close.status);
    expect(close.body).toHaveProperty('status', 'closed');

    const res = await request(http)
      .post('/api/v1/events/join')
      .send({ joinCode: eventJoinCode, primaryName: 'Late Guest', adultsCount: 1, childrenCount: 0 });
    expect(res.status).toBe(423);
    expect(res.body).toHaveProperty('statusCode', 423);
  });

  // ── NEGATIVE: auth + lookups ──────────────────────────────────────────────
  it('NEG · forged/invalid JWT is rejected with 401', async () => {
    const res = await request(http)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });

  it('NEG · invalid event join code returns 404 (no information leak)', async () => {
    const res = await request(http)
      .post('/api/v1/events/join')
      .send({ joinCode: 'NO-SUCH-CODE', primaryName: 'Nobody', adultsCount: 1, childrenCount: 0 });
    expect(res.status).toBe(404);
  });

  // ── MULTI-TENANT ISOLATION (critical) ─────────────────────────────────────
  it('TENANT · Org B cannot read Org A group or event (cross-tenant isolation)', async () => {
    const orgB = await request(http).post('/api/v1/auth/signup/admin').send({
      name: 'Org B Admin',
      role: 'organizationManager',
      email: `adminB_${uniq()}@example.com`,
      password,
      organizationName: `OrgB ${uniq()}`,
    });
    ok(orgB.status);
    const tokenB = orgB.body.accessToken;

    const g = await request(http)
      .get(`/api/v1/groups/${groupId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([403, 404]).toContain(g.status); // must NOT be 200

    const e = await request(http)
      .get(`/api/v1/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect([403, 404]).toContain(e.status);

    const att = await request(http)
      .post('/api/v1/attendance')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ mealId: openMealId, attendanceDate: todayIst(), status: 'present' });
    expect([403, 404]).toContain(att.status); // Org A meal invisible to Org B
  });

  // ── B1: SESSION LIFECYCLE ─────────────────────────────────────────────────
  it('B1 · refresh rotates tokens', async () => {
    const res = await request(http)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    ok(res.status);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    refreshToken = res.body.refreshToken;
    accessToken = res.body.accessToken;
  });

  it('B1 · logout succeeds', async () => {
    const res = await request(http)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    expect([200, 201, 204]).toContain(res.status);
  });

  // ── SECURITY: cross-cutting ───────────────────────────────────────────────
  it('SEC · protected group route rejects an unauthenticated request', async () => {
    const res = await request(http).post('/api/v1/groups').send({ name: 'x', type: 'mess' });
    expect(res.status).toBe(401);
  });
});
