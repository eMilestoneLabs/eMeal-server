import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  EventEntity,
  EventMealTypeEntity,
  EventGuestPartyEntity,
  EventPersonEntity,
  EventStatsEntity,
} from '../entities/event.entity';

interface CreateEventData {
  organizationId: string;
  adminId: string;
  adminName: string;
  name: string;
  type: string;
  eventDate: Date;
  expectedGuestCount: number;
  autoDeleteAfter7Days: boolean;
  autoDeleteAt: Date | null;
}

interface UpdateEventData {
  name?: string;
  type?: string;
  eventDate?: Date;
  expectedGuestCount?: number;
  autoDeleteAfter7Days?: boolean;
  autoDeleteAt?: Date | null;
  isActive?: boolean;
  closedAt?: Date | null;   // GAP-EVT-1
  archivedAt?: Date | null; // GAP-EVT-1
}

interface FindManyOptions {
  page: number;
  limit: number;
  activeOnly?: boolean;
  type?: string;
}

interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * EventsRepository — all DB access for Events.
 *
 * Multi-tenant isolation: every query filters by organizationId from JWT.
 * adminName resolved at query time via User join — never trusted from client.
 * Cascade deletes: EventMealType, EventGuestParty, EventPerson all cascade from Event.
 */
@Injectable()
export class EventsRepository {
  private readonly logger = new Logger(EventsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── BUILDER HELPERS ───────────────────────────────────────────────────────

  private buildPersonEntity(p: any): EventPersonEntity {
    return new EventPersonEntity({
      id: p.id,
      partyId: p.partyId,
      displayName: p.displayName,
      isAdult: p.isAdult,
      isPrimary: p.isPrimary,
      isNameEdited: p.isNameEdited,
      isPresent: p.isPresent,
      selectedMealTypeId: p.selectedMealTypeId ?? null,
      mealPreference: p.mealPreference ?? null,
      createdAt: p.createdAt,
    });
  }

  private buildMealTypeEntity(mt: any): EventMealTypeEntity {
    return new EventMealTypeEntity({
      id: mt.id,
      eventId: mt.eventId,
      title: mt.title,
      emoji: mt.emoji ?? null,
      colorValue: mt.colorValue ?? null,
      isVeg: mt.isVeg,
      createdAt: mt.createdAt,
    });
  }

  private buildPartyEntity(party: any): EventGuestPartyEntity {
    return new EventGuestPartyEntity({
      id: party.id,
      eventId: party.eventId,
      primaryName: party.primaryName,
      adultsCount: party.adultsCount,
      childrenCount: party.childrenCount,
      joinedAt: party.joinedAt,
      persons: (party.persons ?? []).map((p: any) => this.buildPersonEntity(p)),
    });
  }

  private buildEventEntity(event: any, adminName: string): EventEntity {
    return new EventEntity({
      id: event.id,
      organizationId: event.organizationId,
      adminId: event.adminId,
      adminName,
      name: event.name,
      type: event.type,
      eventDate: event.eventDate,
      expectedGuestCount: event.expectedGuestCount,
      joinCode: event.joinToken, // serialized as joinCode
      autoDeleteAfter7Days: event.autoDeleteAfter7Days,
      autoDeleteAt: event.autoDeleteAt ?? null,
      isActive: event.isActive,
      closedAt: event.closedAt ?? null,
      archivedAt: event.archivedAt ?? null,
      mealTypes: (event.mealTypes ?? []).map((mt: any) => this.buildMealTypeEntity(mt)),
      guestParties: (event.guestParties ?? []).map((p: any) => this.buildPartyEntity(p)),
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    });
  }

  /** Resolve admin display name from users table. */
  private async resolveAdminName(adminId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { name: true },
    });
    return user?.name ?? 'Unknown';
  }

  // ── EVENT CRUD ────────────────────────────────────────────────────────────

  async create(data: CreateEventData): Promise<EventEntity> {
    const event = await this.prisma.event.create({
      data: {
        organizationId: data.organizationId,
        adminId: data.adminId,
        name: data.name,
        type: data.type as any,
        eventDate: data.eventDate,
        expectedGuestCount: data.expectedGuestCount,
        autoDeleteAfter7Days: data.autoDeleteAfter7Days,
        autoDeleteAt: data.autoDeleteAt,
      },
      include: {
        mealTypes: true,
        guestParties: { include: { persons: true } },
      },
    });

    return this.buildEventEntity(event, data.adminName);
  }

  async findById(id: string, organizationId: string): Promise<EventEntity | null> {
    const event = await this.prisma.event.findFirst({
      where: { id, organizationId },
      include: {
        mealTypes: { orderBy: { createdAt: 'asc' } },
        guestParties: {
          orderBy: { joinedAt: 'asc' },
          include: {
            persons: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });
    if (!event) return null;

    const adminName = await this.resolveAdminName(event.adminId);
    return this.buildEventEntity(event, adminName);
  }

  async findByJoinToken(joinToken: string): Promise<EventEntity | null> {
    const event = await this.prisma.event.findUnique({
      where: { joinToken },
      include: {
        mealTypes: { orderBy: { createdAt: 'asc' } },
        guestParties: {
          include: { persons: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    if (!event) return null;

    const adminName = await this.resolveAdminName(event.adminId);
    return this.buildEventEntity(event, adminName);
  }

  async findMany(
    organizationId: string,
    opts: FindManyOptions,
  ): Promise<PaginatedResult<EventEntity>> {
    const { page, limit, activeOnly, type } = opts;
    const skip = (page - 1) * limit;

    const where: any = { organizationId };
    if (activeOnly) where.isActive = true;
    if (type) where.type = type;

    const [total, events] = await this.prisma.$transaction([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where,
        skip,
        take: limit,
        orderBy: { eventDate: 'desc' },
        include: {
          mealTypes: { orderBy: { createdAt: 'asc' } },
          guestParties: false,
        },
      }),
    ]);

    // Resolve admin names in parallel
    const adminIds = [...new Set(events.map((e: any) => e.adminId))];
    const admins = await this.prisma.user.findMany({
      where: { id: { in: adminIds as string[] } },
      select: { id: true, name: true },
    });
    const adminMap = new Map(admins.map((a: any) => [a.id, a.name]));

    const entities = events.map((e: any) =>
      this.buildEventEntity(e, adminMap.get(e.adminId) ?? 'Unknown'),
    );

    return { data: entities, total, page, limit };
  }

  async update(
    id: string,
    organizationId: string,
    data: UpdateEventData,
  ): Promise<EventEntity> {
    const event = await this.prisma.event.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.type !== undefined && { type: data.type as any }),
        ...(data.eventDate !== undefined && { eventDate: data.eventDate }),
        ...(data.expectedGuestCount !== undefined && { expectedGuestCount: data.expectedGuestCount }),
        ...(data.autoDeleteAfter7Days !== undefined && { autoDeleteAfter7Days: data.autoDeleteAfter7Days }),
        ...(data.autoDeleteAt !== undefined && { autoDeleteAt: data.autoDeleteAt }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.closedAt !== undefined && { closedAt: data.closedAt }),
        ...(data.archivedAt !== undefined && { archivedAt: data.archivedAt }),
      },
      include: {
        mealTypes: { orderBy: { createdAt: 'asc' } },
        guestParties: { include: { persons: true } },
      },
    });

    const adminName = await this.resolveAdminName(event.adminId);
    return this.buildEventEntity(event, adminName);
  }

  async delete(id: string, organizationId: string): Promise<void> {
    // Verify org ownership before delete
    await this.prisma.event.deleteMany({ where: { id, organizationId } });
  }

  // ── MEAL TYPES ────────────────────────────────────────────────────────────

  async createMealType(
    eventId: string,
    data: { title: string; emoji?: string | null; colorValue?: number | null; isVeg?: boolean },
  ): Promise<EventMealTypeEntity> {
    const mt = await this.prisma.eventMealType.create({
      data: {
        eventId,
        title: data.title,
        emoji: data.emoji ?? null,
        colorValue: data.colorValue ?? null,
        isVeg: data.isVeg ?? true,
      },
    });
    return this.buildMealTypeEntity(mt);
  }

  async updateMealType(
    mealTypeId: string,
    eventId: string,
    data: { title?: string; emoji?: string | null; colorValue?: number | null; isVeg?: boolean },
  ): Promise<EventMealTypeEntity> {
    const mt = await this.prisma.eventMealType.update({
      where: { id: mealTypeId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.emoji !== undefined && { emoji: data.emoji }),
        ...(data.colorValue !== undefined && { colorValue: data.colorValue }),
        ...(data.isVeg !== undefined && { isVeg: data.isVeg }),
      },
    });
    return this.buildMealTypeEntity(mt);
  }

  async deleteMealType(mealTypeId: string, eventId: string): Promise<void> {
    await this.prisma.eventMealType.deleteMany({
      where: { id: mealTypeId, eventId },
    });
  }

  async findMealType(mealTypeId: string, eventId: string): Promise<EventMealTypeEntity | null> {
    const mt = await this.prisma.eventMealType.findFirst({
      where: { id: mealTypeId, eventId },
    });
    if (!mt) return null;
    return this.buildMealTypeEntity(mt);
  }

  // ── GUEST PARTIES ─────────────────────────────────────────────────────────

  /**
   * Create a party with auto-generated EventPerson rows.
   * Person names default to "Guest-N" and can be edited later.
   * Primary person is isPrimary=true with the supplied name.
   */
  /** Pass 14 (FR-EVTX-002): resume lookup — the party this device already created. */
  async findPartyByDeviceKey(
    eventId: string,
    deviceKey: string,
  ): Promise<EventGuestPartyEntity | null> {
    const party = await this.prisma.eventGuestParty.findFirst({
      where: { eventId, deviceKey },
      include: { persons: { orderBy: { createdAt: 'asc' } } },
    });
    if (!party) return null;
    return this.buildPartyEntity(party);
  }

  async createParty(
    eventId: string,
    data: {
      primaryName: string;
      adultsCount: number;
      childrenCount: number;
      deviceKey?: string | null;
    },
  ): Promise<EventGuestPartyEntity> {
    const { primaryName, adultsCount, childrenCount } = data;

    const party = await this.prisma.$transaction(async (tx) => {
      const ev = await tx.event.findUnique({
        where: { id: eventId },
        select: { organizationId: true },
      });
      const p = await tx.eventGuestParty.create({
        data: {
          eventId,
          organizationId: ev!.organizationId,
          primaryName,
          adultsCount,
          childrenCount,
          // Pass 14 (FR-EVTX-002): remember which device created the party.
          ...(data.deviceKey ? { deviceKey: data.deviceKey } : {}),
        } as any,
      });

      // Auto-generate person rows
      const personData: any[] = [];

      // GAP-EVT-3 (RESOLVED): persons are created ATTENDING by default —
      // the UI shows "N/N attending" immediately after join; guests then
      // deselect members who will not attend. isPresent is set deliberately.
      // Primary person
      personData.push({
        partyId: p.id,
        displayName: primaryName,
        isAdult: true,
        isPrimary: true,
        isNameEdited: true,
        isPresent: true,
      });

      // Remaining adults — Guest-2 ... Guest-{adultsCount}
      for (let i = 1; i < adultsCount; i++) {
        personData.push({
          partyId: p.id,
          displayName: `Guest-${i + 1}`,
          isAdult: true,
          isPrimary: false,
          isNameEdited: false,
          isPresent: true,
        });
      }

      // Children — numbering CONTINUES after adults (Event_Guest.md + UI:
      // 3 adults + 2 children → Guest-4 [Child], Guest-5 [Child], not Child-1/2)
      for (let i = 0; i < childrenCount; i++) {
        personData.push({
          partyId: p.id,
          displayName: `Guest-${adultsCount + i + 1}`,
          isAdult: false,
          isPrimary: false,
          isNameEdited: false,
          isPresent: true,
        });
      }

      await tx.eventPerson.createMany({ data: personData });

      // Fetch with persons
      return tx.eventGuestParty.findUnique({
        where: { id: p.id },
        include: { persons: { orderBy: { createdAt: 'asc' } } },
      });
    });

    return this.buildPartyEntity(party);
  }

  async findParties(
    eventId: string,
    opts: { page: number; limit: number },
  ): Promise<PaginatedResult<EventGuestPartyEntity>> {
    const skip = (opts.page - 1) * opts.limit;

    const [total, parties] = await this.prisma.$transaction([
      this.prisma.eventGuestParty.count({ where: { eventId } }),
      this.prisma.eventGuestParty.findMany({
        where: { eventId },
        skip,
        take: opts.limit,
        orderBy: { joinedAt: 'asc' },
        include: { persons: { orderBy: { createdAt: 'asc' } } },
      }),
    ]);

    return {
      data: parties.map((p: any) => this.buildPartyEntity(p)),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  }

  /**
   * Pass 14 (FR-EVTX-004): count edits RECONCILE person rows in the same
   * transaction — placeholders are added/removed so counts and persons never
   * diverge, and already-named or attending persons are never lost silently.
   * Removal picks unnamed non-primary placeholders, not-attending first; if
   * the reduction would require deleting a named/edited person, the caller
   * gets a 422 telling the user to remove that person explicitly.
   */
  async updateParty(
    partyId: string,
    eventId: string,
    data: { primaryName?: string; adultsCount?: number; childrenCount?: number },
  ): Promise<EventGuestPartyEntity> {
    const party = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.eventGuestParty.update({
        where: { id: partyId },
        data: {
          ...(data.primaryName !== undefined && { primaryName: data.primaryName }),
          ...(data.adultsCount !== undefined && { adultsCount: data.adultsCount }),
          ...(data.childrenCount !== undefined && { childrenCount: data.childrenCount }),
        },
        include: { persons: { orderBy: { createdAt: 'asc' } } },
      });

      if (data.adultsCount === undefined && data.childrenCount === undefined) {
        return updated;
      }

      // Placeholder numbering continues from the highest existing "Guest-N".
      let nextGuestNumber =
        updated.persons.reduce((max: number, per: any) => {
          const m = /^Guest-(\d+)$/.exec(per.displayName);
          return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, updated.persons.length) + 1;

      const toCreate: any[] = [];
      const toDelete: string[] = [];

      for (const isAdult of [true, false]) {
        const target = isAdult ? updated.adultsCount : updated.childrenCount;
        const group = updated.persons.filter((per: any) => per.isAdult === isAdult);
        const diff = target - group.length;
        if (diff > 0) {
          for (let i = 0; i < diff; i++) {
            toCreate.push({
              partyId: updated.id,
              displayName: `Guest-${nextGuestNumber++}`,
              isAdult,
              isPrimary: false,
              isNameEdited: false,
              isPresent: true,
            });
          }
        } else if (diff < 0) {
          // Only unedited, non-primary placeholders are removable;
          // not-attending ones go first (least information lost).
          const removable = group
            .filter((per: any) => !per.isPrimary && !per.isNameEdited)
            .sort(
              (a: any, b: any) => Number(a.isPresent) - Number(b.isPresent),
            );
          if (removable.length < -diff) {
            throw new UnprocessableEntityException({
              message:
                'Cannot reduce the count below your named guests — remove a specific person instead',
              code: 'PARTY_PERSONS_CONFLICT',
              errors: {
                [isAdult ? 'adultsCount' : 'childrenCount']:
                  'Named or attending persons are never deleted silently',
              },
            });
          }
          for (const per of removable.slice(0, -diff)) toDelete.push(per.id);
        }
      }

      if (toDelete.length > 0) {
        await tx.eventPerson.deleteMany({ where: { id: { in: toDelete } } });
      }
      if (toCreate.length > 0) {
        await tx.eventPerson.createMany({ data: toCreate });
      }

      return tx.eventGuestParty.findUnique({
        where: { id: partyId },
        include: { persons: { orderBy: { createdAt: 'asc' } } },
      });
    });
    return this.buildPartyEntity(party);
  }

  async deleteParty(partyId: string, eventId: string): Promise<void> {
    await this.prisma.eventGuestParty.deleteMany({
      where: { id: partyId, eventId },
    });
  }

  async findPartyById(partyId: string, eventId: string): Promise<EventGuestPartyEntity | null> {
    const party = await this.prisma.eventGuestParty.findFirst({
      where: { id: partyId, eventId },
      include: { persons: { orderBy: { createdAt: 'asc' } } },
    });
    if (!party) return null;
    return this.buildPartyEntity(party);
  }

  // ── PERSONS ───────────────────────────────────────────────────────────────

  async updatePersonPresence(
    personId: string,
    eventId: string,
    isPresent: boolean,
  ): Promise<EventPersonEntity | null> {
    // Verify person belongs to event via party
    const person = await this.prisma.eventPerson.findFirst({
      where: {
        id: personId,
        party: { eventId },
      },
    });
    if (!person) return null;

    const updated = await this.prisma.eventPerson.update({
      where: { id: personId },
      data: { isPresent },
    });
    return this.buildPersonEntity(updated);
  }

  async updatePersonDetails(
    personId: string,
    eventId: string,
    data: {
      displayName?: string;
      selectedMealTypeId?: string | null;
      mealPreference?: string | null;
    },
  ): Promise<EventPersonEntity | null> {
    const person = await this.prisma.eventPerson.findFirst({
      where: { id: personId, party: { eventId } },
    });
    if (!person) return null;

    const updated = await this.prisma.eventPerson.update({
      where: { id: personId },
      data: {
        ...(data.displayName !== undefined && {
          displayName: data.displayName,
          isNameEdited: true,
        }),
        ...(data.selectedMealTypeId !== undefined && {
          selectedMealTypeId: data.selectedMealTypeId,
          mealTypeId: data.selectedMealTypeId,
        }),
        ...(data.mealPreference !== undefined && { mealPreference: data.mealPreference }),
      },
    });
    return this.buildPersonEntity(updated);
  }

  // ── STATS ─────────────────────────────────────────────────────────────────

  async computeStats(eventId: string, organizationId: string): Promise<EventStatsEntity> {
    // Single-query aggregate: count persons grouped by isAdult + isPresent
    const [persons, mealTypes] = await this.prisma.$transaction([
      this.prisma.eventPerson.findMany({
        where: { party: { eventId } },
        select: {
          isAdult: true,
          isPresent: true,
          selectedMealTypeId: true,
          mealPreference: true,
        },
      }),
      this.prisma.eventMealType.findMany({
        where: { eventId },
        select: { id: true, title: true, isVeg: true },
      }),
    ]);

    const total = persons.length;
    const adults = persons.filter((p: any) => p.isAdult).length;
    const children = persons.filter((p: any) => !p.isAdult).length;

    // CRITICAL BUSINESS RULE (Event_admin.md §12): all meal analytics are
    // calculated from ATTENDING guests only. Registered ≠ Attending.
    // "Absent Guests = No Meal Required."
    const attending = persons.filter((p: any) => p.isPresent);
    const present = attending.length;

    // Veg/non-veg classification: prefer the selected meal type's isVeg flag;
    // fall back to the mealPreference string for legacy rows.
    const vegTypeIds = new Set(
      mealTypes.filter((mt: any) => mt.isVeg).map((mt: any) => mt.id),
    );
    const nonVegTypeIds = new Set(
      mealTypes.filter((mt: any) => !mt.isVeg).map((mt: any) => mt.id),
    );
    const vegPrefs = new Set(['veg', 'jain']);
    const vegCount = attending.filter((p: any) =>
      p.selectedMealTypeId
        ? vegTypeIds.has(p.selectedMealTypeId)
        : p.mealPreference && vegPrefs.has(p.mealPreference),
    ).length;
    const nonVegCount = attending.filter((p: any) =>
      p.selectedMealTypeId
        ? nonVegTypeIds.has(p.selectedMealTypeId)
        : p.mealPreference && !vegPrefs.has(p.mealPreference),
    ).length;

    // Meal type breakdown — attending guests only
    const mealTypeCountMap = new Map<string, number>();
    for (const p of attending) {
      if (p.selectedMealTypeId) {
        mealTypeCountMap.set(
          p.selectedMealTypeId,
          (mealTypeCountMap.get(p.selectedMealTypeId) ?? 0) + 1,
        );
      }
    }
    const mealTypeBreakdown = mealTypes.map((mt: any) => ({
      mealTypeId: mt.id,
      title: mt.title,
      count: mealTypeCountMap.get(mt.id) ?? 0,
    }));

    // Pending = attending guests without any meal selection
    const pending = attending.filter(
      (p: any) => !p.selectedMealTypeId && !p.mealPreference,
    ).length;

    return new EventStatsEntity({
      eventId,
      total,
      adults,
      children,
      present,
      pending,
      vegCount,
      nonVegCount,
      mealTypeBreakdown,
    });
  }

  // ── OWNERSHIP CHECK ───────────────────────────────────────────────────────

  /** Verify an event belongs to the given org — for use in service guard checks. */
  async verifyOwnership(id: string, organizationId: string): Promise<boolean> {
    const count = await this.prisma.event.count({ where: { id, organizationId } });
    return count > 0;
  }

  /**
   * GAP-EVT-2: count guests who have selected this meal type.
   * Deletion must be blocked when > 0 (source-of-truth rule).
   * Checks both selectedMealTypeId (contract field) and mealTypeId (FK).
   */
  async countMealTypeSelections(mealTypeId: string, eventId: string): Promise<number> {
    return this.prisma.eventPerson.count({
      where: {
        party: { eventId },
        OR: [{ selectedMealTypeId: mealTypeId }, { mealTypeId }],
      },
    });
  }

  /** Verify a meal type belongs to an event in the given org. */
  async verifyMealTypeOwnership(
    mealTypeId: string,
    eventId: string,
    organizationId: string,
  ): Promise<boolean> {
    const mt = await this.prisma.eventMealType.findFirst({
      where: { id: mealTypeId, eventId, event: { organizationId } },
    });
    return mt !== null;
  }

  /** Verify a party belongs to an event in the given org. */
  async verifyPartyOwnership(
    partyId: string,
    eventId: string,
    organizationId: string,
  ): Promise<boolean> {
    const party = await this.prisma.eventGuestParty.findFirst({
      where: { id: partyId, eventId, event: { organizationId } },
    });
    return party !== null;
  }
}
