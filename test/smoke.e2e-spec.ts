/**
 * smoke.e2e-spec.ts — SMOKE + SANITY layer.
 *
 * Cheapest end-to-end signal: does the app boot, wire every module, and behave
 * at the edges? No business data required. If this fails, deeper e2e is moot.
 *
 *   - app boots (all modules/providers resolve, Prisma + Redis + BullMQ connect)
 *   - GET /api/v1/health responds with the health contract
 *   - global /api/v1 prefix is enforced (unprefixed route 404s)
 *   - unknown route -> 404
 *   - protected route without a token -> 401 (global JwtAuthGuard)
 *   - invalid signup body -> 422 (global ValidationPipe, errorHttpStatusCode)
 */
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/test-app';

describe('SMOKE / SANITY (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('boots the application without errors', () => {
    expect(app).toBeDefined();
    expect(app.getHttpServer()).toBeDefined();
  });

  it('GET /api/v1/health returns the health contract', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status'); // 'ok' | 'degraded'
    expect(res.body).toHaveProperty('database');
    expect(res.body).toHaveProperty('redis');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('enforces the /api/v1 global prefix (unprefixed health 404s)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(404);
  });

  it('unknown route returns 404', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('protected route without token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('invalid signup body returns 422 (validation pipe)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup/admin')
      .send({ name: '', role: 'not-a-role' }); // missing password, bad role
    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('statusCode', 422);
  });

  it('rejects unknown fields in request body (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: 'x@y.com', password: 'password123', hacker: true });
    expect(res.status).toBe(422);
  });
});
