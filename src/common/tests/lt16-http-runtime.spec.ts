/**
 * Live-Test-16 — HTTP-level RUNTIME checks for every route this batch added
 * or whose contract it changed. Boots the REAL controllers under the SAME
 * global config as src/main.ts (api/v1 prefix, whitelist + forbid, 422) and
 * drives them over HTTP (supertest): routing precedence, DTO validation and
 * role gating are exercised exactly as in production. Services are mocked —
 * their logic has its own unit specs. Test-only: never compiled into dist.
 *
 * Auth is simulated by an `x-test-user` header (the JWT guard is replaced);
 * the admin gate is kept as a role check mirroring @Roles(...ADMIN_ROLES).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import {
  BillingController,
  BillingMemberController,
} from '../../features/billing/billing.controller';
import { BillingService } from '../../features/billing/billing.service';
import { GroupsController } from '../../features/groups/groups.controller';
import { GroupsService } from '../../features/groups/groups.service';
import { VacationsController } from '../../features/vacations/vacations.controller';
import { VacationsService } from '../../features/vacations/vacations.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { EmailVerifiedGuard } from '../guards/email-verified.guard';
import { ADMIN_ROLES } from '../decorators/roles.decorator';

const STUDENT = { sub: 'stu-1', organizationId: 'org-1', role: 'student' };
const ADMIN = { sub: 'adm-1', organizationId: 'org-1', role: 'hostelAdmin' };
const as = (u: object) => ({ 'x-test-user': JSON.stringify(u) });

describe('LT-16 HTTP runtime (real controllers + main.ts pipe)', () => {
  let app: INestApplication;
  const billing = {
    listMyAdjustments: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 }),
    listAdjustments: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
    listMyPendingAdjustments: jest.fn().mockResolvedValue({ data: [] }),
    createAdjustment: jest.fn().mockResolvedValue({ id: 'adj-1' }),
  };
  const groups = { updateGroup: jest.fn().mockResolvedValue({ id: 'g-1' }) };
  const vacations = { createRequest: jest.fn().mockResolvedValue({ id: 'v-1' }) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        BillingController,
        BillingMemberController,
        GroupsController,
        VacationsController,
      ],
      providers: [
        { provide: BillingService, useValue: billing },
        { provide: GroupsService, useValue: groups },
        { provide: VacationsService, useValue: vacations },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const raw = req.headers['x-test-user'];
          if (!raw) return false;
          req.user = JSON.parse(raw);
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (ctx: any) =>
          (ADMIN_ROLES as readonly string[]).includes(
            ctx.switchToHttp().getRequest().user?.role,
          ),
      })
      .overrideGuard(EmailVerifiedGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror src/main.ts exactly.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        errorHttpStatusCode: 422,
      }),
    );
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  // ── ISSUE-16: /billing/adjustments/mine ────────────────────────────────
  it('GET /billing/adjustments/mine routes to the MEMBER handler with the JWT subject', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/billing/adjustments/mine')
      .query({ groupId: 'g-1', userId: 'someone-else', fromDate: '2026-09-01', toDate: '2026-09-30', page: 1, limit: 100 })
      .set(as(STUDENT));
    expect(res.status).toBe(200);
    expect(billing.listMyAdjustments).toHaveBeenCalledTimes(1);
    const [org, uid, query] = billing.listMyAdjustments.mock.calls[0];
    expect(org).toBe('org-1');
    expect(uid).toBe('stu-1'); // the caller — the service then forces it over any client userId
    expect(query).toMatchObject({ groupId: 'g-1', page: 1, limit: 100 });
    expect(billing.listAdjustments).not.toHaveBeenCalled();
  });

  it('GET /billing/adjustments/mine without auth is rejected (403)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/billing/adjustments/mine')
      .query({ groupId: 'g-1' });
    expect(res.status).toBe(403);
    expect(billing.listMyAdjustments).not.toHaveBeenCalled();
  });

  it('the ADMIN list stays admin-only: a student gets 403 on /billing/adjustments', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/billing/adjustments')
      .query({ groupId: 'g-1', userId: 'victim' })
      .set(as(STUDENT));
    expect(res.status).toBe(403);
    expect(billing.listAdjustments).not.toHaveBeenCalled();
  });

  it('regression: /billing/adjustments/my-pending still resolves to its own handler', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/billing/adjustments/my-pending')
      .set(as(STUDENT));
    expect(res.status).toBe(200);
    expect(billing.listMyPendingAdjustments).toHaveBeenCalledWith('org-1', 'stu-1');
    expect(billing.listMyAdjustments).not.toHaveBeenCalled();
  });

  // ── ISSUE-1: reason ≤ 30 characters ──────────────────────────────────────
  const adj = (reason: string) => ({ groupId: 'g-1', userId: 'stu-1', type: 'credit', amount: 100, reason });
  const postedDto = () => billing.createAdjustment.mock.calls[0][2];

  it('POST /billing/adjustments accepts a 30-character reason', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/billing/adjustments')
      .send(adj('x'.repeat(30)))
      .set(as(ADMIN));
    expect(res.status).toBe(201);
    expect(postedDto().reason).toBe('x'.repeat(30));
  });

  it('POST /billing/adjustments rejects a 31-character reason (422, service never called)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/billing/adjustments')
      .send(adj('x'.repeat(31)))
      .set(as(ADMIN));
    expect(res.status).toBe(422);
    expect(billing.createAdjustment).not.toHaveBeenCalled();
  });

  it('a 30-char reason padded with spaces is trimmed first, then accepted', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/billing/adjustments')
      .send(adj(`  ${'y'.repeat(30)}  `))
      .set(as(ADMIN));
    expect(res.status).toBe(201);
    expect(postedDto().reason).toBe('y'.repeat(30));
  });

  // ── ISSUE-4: guest cap 5 + retired adult/child mode ──────────────────────
  const guestPatch = (guestConfig: object) => ({ guestConfig });

  it('PATCH /groups/:id/meal-config accepts 5 guests/meal and sameAsMember', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/groups/g-1/meal-config')
      .send(guestPatch({ maxGuestsPerMemberPerMeal: 5, guestPricingMode: 'sameAsMember' }))
      .set(as(ADMIN));
    expect(res.status).toBe(200);
    expect(groups.updateGroup).toHaveBeenCalledTimes(1);
  });

  it('PATCH /groups/:id/meal-config rejects 6 guests/meal (422)', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/groups/g-1/meal-config')
      .send(guestPatch({ maxGuestsPerMemberPerMeal: 6 }))
      .set(as(ADMIN));
    expect(res.status).toBe(422);
    expect(groups.updateGroup).not.toHaveBeenCalled();
  });

  it('PATCH /groups/:id (full update) enforces the same guest rules on the nested mealConfig', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/groups/g-1')
      .send({ mealConfig: guestPatch({ guestPricingMode: 'perGuestPrice' }) })
      .set(as(ADMIN));
    expect(res.status).toBe(422);
    expect(groups.updateGroup).not.toHaveBeenCalled();
  });

  it('flatSurcharge stays accepted (unchanged mode)', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/groups/g-1/meal-config')
      .send(guestPatch({ guestPricingMode: 'flatSurcharge', guestSurcharge: 10 }))
      .set(as(ADMIN));
    expect(res.status).toBe(200);
  });

  it('a student cannot change guest settings (403)', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/groups/g-1/meal-config')
      .send(guestPatch({ maxGuestsPerMemberPerMeal: 2 }))
      .set(as(STUDENT));
    expect(res.status).toBe(403);
  });

  // ── ISSUE-19 / ISSUE-2: vacation request contract ────────────────────────
  it('POST /vacation-requests carries groupId + slot bounds through to the service', async () => {
    const body = {
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      groupId: 'g-1',
      startSlotKey: 'dinner',
      reason: 'home',
    };
    const res = await request(app.getHttpServer())
      .post('/api/v1/vacation-requests')
      .send(body)
      .set(as(STUDENT));
    expect(res.status).toBe(201);
    const [uid, org, dto] = vacations.createRequest.mock.calls[0];
    expect(uid).toBe('stu-1');
    expect(org).toBe('org-1');
    expect(dto).toMatchObject(body);
  });

  it('an org-level request (no groupId) is still accepted — backward compatible', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vacation-requests')
      .send({ startDate: '2026-10-01', endDate: '2026-10-01' })
      .set(as(STUDENT));
    expect(res.status).toBe(201);
  });

  it('an unknown field is still rejected (forbidNonWhitelisted intact)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vacation-requests')
      .send({ startDate: '2026-10-01', endDate: '2026-10-01', organizationId: 'org-2' })
      .set(as(STUDENT));
    expect(res.status).toBe(422);
    expect(vacations.createRequest).not.toHaveBeenCalled();
  });
});
