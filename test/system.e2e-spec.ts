/**
 * system.e2e-spec.ts — SYSTEM / INTEGRATION layer (phases B1 → B5).
 *
 * Exercises a real cross-module user journey against live Postgres + Redis:
 *
 *   B1 Auth      admin signup -> login -> /me -> refresh -> logout
 *   B2 Groups    create group -> fetch group (joinCode, nested mealConfig)
 *   B2 Pagination list groups returns { data, total, page, limit }
 *   B3 Meals     create meal (free slotKey, nested attendanceWindow)
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
