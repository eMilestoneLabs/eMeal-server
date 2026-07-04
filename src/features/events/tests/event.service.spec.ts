/**
 * event.service.spec.ts — B5: EventsService behavior tests.
 *
 * Instantiated directly with mocked collaborators (no Nest DI bootstrap) so the
 * suite stays fast and free of provider-token resolution. realtime is @Optional.
 *
 * Covers (B1-B9 completion-pass behaviors included):
 *   - EventEntity.status derivation: upcoming / closed / expired / archived (GAP-EVT-1)
 *   - joinEventByCode: 423 lock when event is not upcoming (GAP-EVT-1)
 *   - joinEventByCode: guest.joined.v1 emitted + persons isPresent=true (GAP-WS-1, GAP-EVT-3)
 *   - deleteMealType: 409 Conflict when guests have selected it (GAP-EVT-2)
 *   - closeEvent: persists closedAt, audit-logged, event.updated.v1 emitted
 *   - serializer: additive status/closedAt/archivedAt + locked M-15 "date" key
 *   - org isolation: findById always receives organizationId from JWT
 */
import { ConflictException, HttpException } from '@nestjs/common';
import { EventsService } from '../services/events.service';
import {
  EventEntity,
  EventGuestPartyEntity,
  EventPersonEntity,
} from '../entities/event.entity';
import { EventSerializer } from '../serializers/event.serializer';

const DAY = 24 * 60 * 60 * 1000;

function makeEvent(overrides: Partial<{
  eventDate: Date; isActive: boolean; closedAt: Date | null; archivedAt: Date | null;
}> = {}): EventEntity {
  return new EventEntity({
    id: 'evt_01',
    organizationId: 'org_01',
    adminId: 'usr_admin',
    adminName: 'Admin',
    name: 'Sumita Weddings',
    type: 'wedding',
    eventDate: overrides.eventDate ?? new Date(Date.now() + 7 * DAY),
    expectedGuestCount: 100,
    joinCode: 'LB92EW',
    autoDeleteAfter7Days: false,
    autoDeleteAt: null,
    isActive: overrides.isActive ?? true,
    closedAt: overrides.closedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    mealTypes: [],
    guestParties: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function makeParty(): EventGuestPartyEntity {
  return new EventGuestPartyEntity({
    id: 'party_01',
    eventId: 'evt_01',
    primaryName: 'Rahul Mahanta',
    adultsCount: 2,
    childrenCount: 1,
    joinedAt: new Date(),
    persons: [
      new EventPersonEntity({
        id: 'p1', partyId: 'party_01', displayName: 'Rahul Mahanta',
        isAdult: true, isPrimary: true, isNameEdited: true, isPresent: true,
        createdAt: new Date(),
      }),
      new EventPersonEntity({
        id: 'p2', partyId: 'party_01', displayName: 'Guest-2',
        isAdult: true, isPrimary: false, isNameEdited: false, isPresent: true,
        createdAt: new Date(),
      }),
      new EventPersonEntity({
        id: 'p3', partyId: 'party_01', displayName: 'Guest-3',
        isAdult: false, isPrimary: false, isNameEdited: false, isPresent: true,
        createdAt: new Date(),
      }),
    ],
  });
}

describe('EventsService', () => {
  let service: EventsService;
  let repo: any;
  let audit: any;
  let redis: any;
  let realtime: any;

  beforeEach(() => {
    repo = {
      create: jest.fn(),
      findById: jest.fn(),
      findMany: jest.fn(),
      findByJoinToken: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      createParty: jest.fn(),
      verifyMealTypeOwnership: jest.fn(),
      countMealTypeSelections: jest.fn(),
      deleteMealType: jest.fn(),
    };
    audit = { log: jest.fn() };
    redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    realtime = {
      emitEventUpdated: jest.fn(),
      emitEventStatsUpdated: jest.fn(),
      emitGuestJoined: jest.fn(),
      emitGuestUpdated: jest.fn(),
      emitDashboardSummaryUpdated: jest.fn(),
    };
    service = new EventsService(repo, audit, redis, realtime);
  });

  // ── GAP-EVT-1: derived lifecycle status ───────────────────────────────────
  describe('Event lifecycle status derivation (GAP-EVT-1)', () => {
    it('future event, not closed → upcoming', () => {
      expect(makeEvent().status).toBe('upcoming');
    });
    it('future event with closedAt → closed', () => {
      expect(makeEvent({ closedAt: new Date() }).status).toBe('closed');
    });
    it('past event date → expired (read-only)', () => {
      expect(makeEvent({ eventDate: new Date(Date.now() - 3 * DAY) }).status).toBe('expired');
    });
    it('past event date + closedAt → expired (Closed + date passed → Expired)', () => {
      expect(
        makeEvent({ eventDate: new Date(Date.now() - 3 * DAY), closedAt: new Date() }).status,
      ).toBe('expired');
    });
    it('archivedAt set → archived (hidden, restorable)', () => {
      expect(makeEvent({ archivedAt: new Date() }).status).toBe('archived');
    });
    it('soft-deleted (isActive=false) → archived', () => {
      expect(makeEvent({ isActive: false }).status).toBe('archived');
    });
  });

  // ── Serializer: additive lifecycle keys + locked M-15 date key ────────────
  describe('Event serializer contract', () => {
    it('emits locked keys (date, joinCode) plus ADDITIVE status/closedAt/archivedAt', () => {
      const json = EventSerializer.toResponse(makeEvent());
      expect(json).toHaveProperty('date');           // M-15: Flutter reads json['date']
      expect(json).toHaveProperty('joinCode', 'LB92EW');
      expect(json).not.toHaveProperty('joinToken');  // DB name must never leak
      expect(json).not.toHaveProperty('eventDate');  // never renamed
      expect(json).toHaveProperty('status', 'upcoming'); // additive — ignored by Flutter
      expect(json).toHaveProperty('closedAt', null);
      expect(json).toHaveProperty('archivedAt', null);
      expect(Array.isArray(json.mealTypes)).toBe(true); // always an array
    });
  });

  // ── GAP-EVT-1: join lock ──────────────────────────────────────────────────
  describe('joinEventByCode', () => {
    it('rejects joins to a CLOSED event with HTTP 423 + flat error contract', async () => {
      repo.findByJoinToken.mockResolvedValue(makeEvent({ closedAt: new Date() }));

      const err: any = await service
        .joinEventByCode('LB92EW', 'Rahul Mahanta', 2, 1)
        .then(() => null)
        .catch((e) => e);

      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(423);
      expect(err.getResponse()).toMatchObject({
        message: 'This event is closed and no longer accepting guests.',
        statusCode: 423,
      });
      expect(repo.createParty).not.toHaveBeenCalled();
    });

    it('rejects joins to an EXPIRED event with 423', async () => {
      repo.findByJoinToken.mockResolvedValue(
        makeEvent({ eventDate: new Date(Date.now() - 3 * DAY) }),
      );
      const err: any = await service
        .joinEventByCode('LB92EW', 'Rahul', 1, 0)
        .catch((e) => e);
      expect(err.getStatus()).toBe(423);
    });

    it('UPCOMING event: creates party, emits guest.joined.v1, persons are isPresent=true (GAP-EVT-3)', async () => {
      repo.findByJoinToken.mockResolvedValue(makeEvent());
      repo.createParty.mockResolvedValue(makeParty());

      const res: any = await service.joinEventByCode('LB92EW', 'Rahul Mahanta', 2, 1);

      expect(repo.createParty).toHaveBeenCalledWith('evt_01', {
        primaryName: 'Rahul Mahanta',
        adultsCount: 2,
        childrenCount: 1,
        deviceKey: null, // Pass 14 (FR-EVTX-002): no device key on legacy joins
      });
      // GAP-WS-1: source-of-truth event name emitted (additive to event.updated.v1)
      expect(realtime.emitGuestJoined).toHaveBeenCalledWith(
        'org_01',
        expect.objectContaining({ eventId: 'evt_01', partyId: 'party_01' }),
      );
      expect(realtime.emitEventUpdated).toHaveBeenCalled(); // legacy event still fires
      // Contract: M-16/M-17 field names + GAP-EVT-3 attending-by-default
      expect(res).toMatchObject({ primaryName: 'Rahul Mahanta', adultsCount: 2, childrenCount: 1 });
      expect(res.persons).toHaveLength(3);
      for (const p of res.persons) expect(p.isPresent).toBe(true);
      // Children continue Guest-N numbering (never Child-N)
      expect(res.persons.map((p: any) => p.displayName)).toEqual([
        'Rahul Mahanta', 'Guest-2', 'Guest-3',
      ]);
    });
  });

  // ── GAP-EVT-2: meal type deletion block ───────────────────────────────────
  describe('deleteMealType (GAP-EVT-2)', () => {
    it('throws 409 Conflict when any guest has selected the meal type', async () => {
      repo.verifyMealTypeOwnership.mockResolvedValue(true);
      repo.countMealTypeSelections.mockResolvedValue(3);

      const err: any = await service
        .deleteMealType('evt_01', 'mt_01', 'org_01', 'usr_admin', 'eventAdmin')
        .then(() => null)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(String((err.getResponse() as any).message)).toContain('guests have already selected');
      expect(repo.deleteMealType).not.toHaveBeenCalled();
    });

    it('deletes when no guest has selected it (and audit-logs the action)', async () => {
      repo.verifyMealTypeOwnership.mockResolvedValue(true);
      repo.countMealTypeSelections.mockResolvedValue(0);
      repo.deleteMealType.mockResolvedValue(undefined);

      await service.deleteMealType('evt_01', 'mt_01', 'org_01', 'usr_admin', 'eventAdmin');

      expect(repo.deleteMealType).toHaveBeenCalledWith('mt_01', 'evt_01');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'EventMealType', action: 'delete' }),
      );
    });
  });

  // ── GAP-EVT-1: Close Event lifecycle action ───────────────────────────────
  describe('closeEvent (GAP-EVT-1)', () => {
    it('persists closedAt, audit-logs, emits event.updated.v1(action=closed), serializes status=closed', async () => {
      repo.findById.mockResolvedValue(makeEvent());
      repo.update.mockResolvedValue(makeEvent({ closedAt: new Date() }));

      const res: any = await service.closeEvent('evt_01', 'org_01', 'usr_admin', 'eventAdmin');

      // Org isolation: ownership check always uses organizationId from JWT
      expect(repo.findById).toHaveBeenCalledWith('evt_01', 'org_01');
      expect(repo.update).toHaveBeenCalledWith(
        'evt_01', 'org_01',
        expect.objectContaining({ closedAt: expect.any(Date) }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'Event', metadata: { lifecycle: 'closed' } }),
      );
      expect(realtime.emitEventUpdated).toHaveBeenCalledWith(
        'org_01',
        expect.objectContaining({ action: 'closed' }),
      );
      expect(res.status).toBe('closed');
    });
  });

  // ── Governance anchors (kept from original suite) ─────────────────────────
  describe('Event type governance', () => {
    it('stores type as free-form String — no EventType enum on the entity', () => {
      const e = makeEvent();
      expect(typeof e.type).toBe('string');
    });
  });
});
