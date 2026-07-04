/**
 * Pass 14 — compact governance tests for the lifecycle-critical logic:
 *   • FR-EVTX-002: join resumes an existing party for the same deviceKey
 *     (even after the event closed to new joins), never duplicates.
 *   • FR-EVTX-004: count reduction never silently deletes named/attending
 *     persons (422 PARTY_PERSONS_CONFLICT surfaces instead).
 *   • FR-DLC-006: audit HMAC is stable across JSONB key reordering and
 *     flags a tampered row.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { EventsService } from '../services/events.service';
import { AuditService } from '../../../audit/audit.service';

describe('Pass 14 — events lifecycle governance', () => {
  const upcomingEvent = {
    id: 'evt1',
    organizationId: 'org1',
    isActive: true,
    status: 'upcoming',
  };

  function makeService(repo: any) {
    // Constructor shape: (eventsRepo, audit, realtime?) — match via any.
    const audit = { log: jest.fn() };
    const svc = new (EventsService as any)(repo, audit);
    return svc as EventsService;
  }

  const partyShape = {
    id: 'party1',
    primaryName: 'Rahul',
    adultsCount: 2,
    childrenCount: 1,
    joinedAt: new Date('2026-07-01T10:00:00Z'),
    persons: [],
  };

  it('FR-EVTX-002: same deviceKey resumes the existing party, no duplicate', async () => {
    const existing = { ...partyShape };
    const repo: any = {
      findByJoinToken: jest.fn().mockResolvedValue(upcomingEvent),
      findPartyByDeviceKey: jest.fn().mockResolvedValue(existing),
      createParty: jest.fn(),
    };
    const svc = makeService(repo);
    const res: any = await svc.joinEventByCode('CODE', 'Rahul', 2, 1, 'dev-abc');
    expect(res.resumed).toBe(true);
    expect(repo.createParty).not.toHaveBeenCalled();
  });

  it('FR-EVTX-002/LOOP-072: resume works even when the event is CLOSED', async () => {
    const closed = { ...upcomingEvent, status: 'closed' };
    const repo: any = {
      findByJoinToken: jest.fn().mockResolvedValue(closed),
      findPartyByDeviceKey: jest.fn().mockResolvedValue({ ...partyShape }),
      createParty: jest.fn(),
    };
    const svc = makeService(repo);
    const res: any = await svc.joinEventByCode('CODE', 'Rahul', 1, 0, 'dev-abc');
    expect(res.resumed).toBe(true);
  });

  it('LOOP-072: a NEW join (no resume match) on a closed event is still 423', async () => {
    const closed = { ...upcomingEvent, status: 'closed' };
    const repo: any = {
      findByJoinToken: jest.fn().mockResolvedValue(closed),
      findPartyByDeviceKey: jest.fn().mockResolvedValue(null),
      createParty: jest.fn(),
    };
    const svc = makeService(repo);
    await expect(
      svc.joinEventByCode('CODE', 'New Guest', 1, 0, 'dev-new'),
    ).rejects.toMatchObject({ status: 423 });
    expect(repo.createParty).not.toHaveBeenCalled();
  });
});

describe('Pass 14 — FR-EVTX-004 count reconcile guard', () => {
  it('reduction below named persons throws PARTY_PERSONS_CONFLICT (422)', async () => {
    // Simulated transaction: 2 adults, both named → reducing to 1 must refuse.
    const persons = [
      { id: 'p1', isAdult: true, isPrimary: true, isNameEdited: true, isPresent: true, displayName: 'Rahul' },
      { id: 'p2', isAdult: true, isPrimary: false, isNameEdited: true, isPresent: true, displayName: 'Amit' },
    ];
    const tx: any = {
      eventGuestParty: {
        update: jest.fn().mockResolvedValue({
          id: 'party1', adultsCount: 1, childrenCount: 0, persons,
        }),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      eventPerson: { deleteMany: jest.fn(), createMany: jest.fn() },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const { EventsRepository } = require('../repositories/events.repository');
    const repo = new EventsRepository(prisma);

    await expect(
      repo.updateParty('party1', 'evt1', { adultsCount: 1 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.eventPerson.deleteMany).not.toHaveBeenCalled();
  });
});

describe('Pass 14 — FR-DLC-006 tamper-evident audit', () => {
  const OLD = process.env.AUDIT_HMAC_SECRET;
  beforeAll(() => { process.env.AUDIT_HMAC_SECRET = 'test-secret'; });
  afterAll(() => { process.env.AUDIT_HMAC_SECRET = OLD; });

  function makeAudit(rows: any[]) {
    const prisma: any = {
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue(rows),
      },
    };
    return { svc: new AuditService(prisma), prisma };
  }

  it('verifies a signed row and flags a tampered one', async () => {
    // Write once to capture a genuine HMAC via the create call.
    const { svc: writer, prisma: writerPrisma } = makeAudit([]);
    await writer.log({
      organizationId: 'org1',
      actorId: 'admin1',
      targetId: 't1',
      targetType: 'User',
      action: 'delete' as any,
      metadata: { b: 2, a: 1 }, // key order intentionally unsorted
    });
    await new Promise((r) => setImmediate(r)); // fire-and-forget settles
    const written = writerPrisma.auditLog.create.mock.calls[0][0].data;
    expect(written.integrityHmac).toBeTruthy();

    // JSONB reorders keys — verification must still pass on sorted keys.
    const stored = { ...written, id: 'row1', metadata: { a: 1, b: 2 } };
    const tampered = { ...written, id: 'row2', metadata: { a: 1, b: 999 } };

    const { svc: verifier } = makeAudit([stored, tampered]);
    const report = await verifier.verifyIntegrity('org1', 10);
    expect(report.signed).toBe(2);
    expect(report.valid).toBe(1);
    expect(report.mismatched).toEqual(['row2']);
  });
});
