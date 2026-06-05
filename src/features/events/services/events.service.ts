import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { EventsRepository } from '../repositories/events.repository';
import { EventSerializer, EventGuestPartySerializer, EventStatsSerializer, EventMealTypeSerializer } from '../serializers/event.serializer';
import { AuditService } from '../../../audit/audit.service';
import { RedisService } from '../../../redis/redis.service';
import { PaginatedResponseDto } from '../../../common/dto/paginated-response.dto';
import { CreateEventDto } from '../dto/create-event.dto';
import { UpdateEventDto } from '../dto/update-event.dto';
import { CreateMealTypeDto, UpdateMealTypeDto } from '../dto/create-meal-type.dto';
import { CreatePartyDto, UpdatePartyDto } from '../dto/create-party.dto';
import { QueryEventsDto } from '../dto/query-events.dto';
import type { RealtimeEventsService } from '../../../realtime/services/realtime-events.service';

const ADMIN_ROLES = ['messManager', 'hostelManager', 'hostelAdmin', 'organizationManager', 'eventAdmin'];
const EVENT_ADMIN_ROLES = ['eventAdmin', 'hostelAdmin', 'organizationManager'];

// Cache TTL for event stats — 2 minutes (stats change frequently during events)
const EVENT_STATS_TTL = 120;

/**
 * EventsService — business logic for B5 event system.
 *
 * Key rules:
 * - Event admin can manage their own events; org admins can manage all org events.
 * - organizationId always from JWT — never trusted from client.
 * - eventGuest users can only join events via QR (no direct create/manage).
 * - Stats are cached in Redis for 2 minutes.
 * - Cascade deletes: EventMealType → EventPerson, EventGuestParty → EventPerson.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly eventsRepo: EventsRepository,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    @Optional() @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
  ) {}

  // ── EVENTS ────────────────────────────────────────────────────────────────

  async createEvent(
    adminId: string,
    adminName: string,
    organizationId: string,
    role: string,
    dto: CreateEventDto,
    requestId?: string,
  ) {
    this.assertEventAdmin(role);

    const eventDate = new Date(dto.eventDate);
    let autoDeleteAt: Date | null = null;
    if (dto.autoDeleteAfter7Days) {
      autoDeleteAt = new Date(eventDate);
      autoDeleteAt.setDate(autoDeleteAt.getDate() + 7);
    }

    const event = await this.eventsRepo.create({
      organizationId,
      adminId,
      adminName,
      name: dto.name,
      type: dto.type,
      eventDate,
      expectedGuestCount: dto.expectedGuestCount ?? 0,
      autoDeleteAfter7Days: dto.autoDeleteAfter7Days ?? false,
      autoDeleteAt,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: event.id,
      targetType: 'Event',
      action: 'create',
      metadata: { name: dto.name, type: dto.type, eventDate: dto.eventDate },
      requestId,
    });

    this.logger.log(`Event created: \${event.id} name=\${event.name} org=\${organizationId}`);

    // B7: signal admin dashboard that event roster changed
    this.realtime?.emitDashboardSummaryUpdated(organizationId, event.id, {
      organizationId,
      groupId: event.id,  // for events, use eventId as the "groupId" room signal
      date: new Date().toISOString().slice(0, 10),
    });

    return EventSerializer.toResponse(event);
  }

  async getEvents(
    userId: string,
    organizationId: string,
    role: string,
    query: QueryEventsDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Guests see active events only; admins see all
    const isAdmin = ADMIN_ROLES.includes(role);
    const activeOnly = !isAdmin || (query.activeOnly ?? false);

    const result = await this.eventsRepo.findMany(organizationId, {
      page,
      limit,
      activeOnly,
      type: query.type,
    });

    return PaginatedResponseDto.of(
      EventSerializer.toList(result.data),
      result.total,
      result.page,
      result.limit,
    );
  }

  async getEventById(
    id: string,
    organizationId: string,
    role: string,
  ) {
    const event = await this.eventsRepo.findById(id, organizationId);
    if (!event) {
      throw new NotFoundException({
        message: 'Event not found',
        errors: { id: 'Event does not exist in your organization' },
      });
    }

    // Non-admins can only see active events
    if (!ADMIN_ROLES.includes(role) && !event.isActive) {
      throw new NotFoundException({
        message: 'Event not found',
        errors: { id: 'Event is not active' },
      });
    }

    return EventSerializer.toResponse(event);
  }

  async getEventByJoinToken(joinToken: string) {
    const event = await this.eventsRepo.findByJoinToken(joinToken);
    if (!event || !event.isActive) {
      throw new NotFoundException({
        message: 'Event not found',
        errors: { joinToken: 'Invalid or expired event join code' },
      });
    }
    return EventSerializer.toResponse(event);
  }

  /**
   * POST /events/join — Flutter: event_guest_join
   * Resolves event by joinCode (QR scan) and registers a guest party.
   * Does NOT require a JWT — public endpoint for guest registration.
   */
  async joinEventByCode(
    joinCode: string,
    primaryName: string,
    adultsCount: number,
    childrenCount: number,
  ) {
    const event = await this.eventsRepo.findByJoinToken(joinCode);
    if (!event || !event.isActive) {
      throw new NotFoundException({
        message: 'Invalid join code. Please check with your admin.',
        errors: { joinCode: 'No active event found with this join code' },
        statusCode: 404,
      });
    }

    const party = await this.eventsRepo.createParty(event.id, {
      primaryName,
      adultsCount: Math.max(1, adultsCount),
      childrenCount: Math.max(0, childrenCount),
    });

    await this.invalidateEventStats(event.id);

    this.realtime?.emitEventUpdated(event.organizationId, {
      organizationId: event.organizationId,
      eventId: event.id,
      action: 'guest_joined',
    });

    return EventGuestPartySerializer.toResponse(party, true);
  }

  async updateEvent(
    id: string,
    organizationId: string,
    adminId: string,
    role: string,
    dto: UpdateEventDto,
    requestId?: string,
  ) {
    this.assertEventAdmin(role);
    await this.assertEventOwnership(id, organizationId);

    let autoDeleteAt: Date | undefined;
    if (dto.eventDate !== undefined || dto.autoDeleteAfter7Days !== undefined) {
      // Re-compute autoDeleteAt when relevant fields change
      const existing = await this.eventsRepo.findById(id, organizationId);
      const eventDate = dto.eventDate ? new Date(dto.eventDate) : existing!.eventDate;
      const willAutoDelete = dto.autoDeleteAfter7Days ?? existing!.autoDeleteAfter7Days;
      if (willAutoDelete) {
        autoDeleteAt = new Date(eventDate);
        autoDeleteAt.setDate(autoDeleteAt.getDate() + 7);
      } else {
        autoDeleteAt = null as any; // clear
      }
    }

    const updated = await this.eventsRepo.update(id, organizationId, {
      name: dto.name,
      type: dto.type,
      eventDate: dto.eventDate ? new Date(dto.eventDate) : undefined,
      expectedGuestCount: dto.expectedGuestCount,
      autoDeleteAfter7Days: dto.autoDeleteAfter7Days,
      autoDeleteAt,
      isActive: dto.isActive,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'Event',
      action: 'update',
      metadata: dto as any,
      requestId,
    });

    await this.invalidateEventStats(id);

    return EventSerializer.toResponse(updated);
  }

  async deleteEvent(
    id: string,
    organizationId: string,
    adminId: string,
    role: string,
    requestId?: string,
  ) {
    this.assertEventAdmin(role);
    await this.assertEventOwnership(id, organizationId);

    await this.eventsRepo.delete(id, organizationId);
    await this.invalidateEventStats(id);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'Event',
      action: 'delete',
      requestId,
    });

    this.logger.log(`Event deleted: ${id} by admin=${adminId}`);
  }

  // ── MEAL TYPES ────────────────────────────────────────────────────────────

  async createMealType(
    eventId: string,
    organizationId: string,
    adminId: string,
    role: string,
    dto: CreateMealTypeDto,
    requestId?: string,
  ) {
    this.assertEventAdmin(role);
    await this.assertEventOwnership(eventId, organizationId);

    const mt = await this.eventsRepo.createMealType(eventId, {
      title: dto.title,
      emoji: dto.emoji ?? null,
      colorValue: dto.colorValue ?? null,
      isVeg: dto.isVeg ?? true,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: mt.id,
      targetType: 'EventMealType',
      action: 'create',
      metadata: { eventId, title: dto.title },
      requestId,
    });

    return EventMealTypeSerializer.toResponse(mt);
  }

  async updateMealType(
    eventId: string,
    mealTypeId: string,
    organizationId: string,
    adminId: string,
    role: string,
    dto: UpdateMealTypeDto,
    requestId?: string,
  ) {
    this.assertEventAdmin(role);

    const owned = await this.eventsRepo.verifyMealTypeOwnership(mealTypeId, eventId, organizationId);
    if (!owned) {
      throw new NotFoundException({
        message: 'Meal type not found',
        errors: { mealTypeId: 'Meal type does not exist for this event' },
      });
    }

    const mt = await this.eventsRepo.updateMealType(mealTypeId, eventId, {
      title: dto.title,
      emoji: dto.emoji,
      colorValue: dto.colorValue,
      isVeg: dto.isVeg,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: mealTypeId,
      targetType: 'EventMealType',
      action: 'update',
      requestId,
    });

    return EventMealTypeSerializer.toResponse(mt);
  }

  async deleteMealType(
    eventId: string,
    mealTypeId: string,
    organizationId: string,
    adminId: string,
    role: string,
    requestId?: string,
  ) {
    this.assertEventAdmin(role);

    const owned = await this.eventsRepo.verifyMealTypeOwnership(mealTypeId, eventId, organizationId);
    if (!owned) {
      throw new NotFoundException({
        message: 'Meal type not found',
        errors: { mealTypeId: 'Meal type does not exist for this event' },
      });
    }

    await this.eventsRepo.deleteMealType(mealTypeId, eventId);
    await this.invalidateEventStats(eventId);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: mealTypeId,
      targetType: 'EventMealType',
      action: 'delete',
      requestId,
    });
  }

  // ── GUEST PARTIES ─────────────────────────────────────────────────────────

  async createParty(
    eventId: string,
    organizationId: string,
    dto: CreatePartyDto,
  ) {
    await this.assertEventOwnership(eventId, organizationId);

    const party = await this.eventsRepo.createParty(eventId, {
      primaryName: dto.primaryName,
      adultsCount: dto.adultsCount ?? 1,
      childrenCount: dto.childrenCount ?? 0,
    });

    await this.invalidateEventStats(eventId);

    return EventGuestPartySerializer.toResponse(party, true);
  }

  async getParties(
    eventId: string,
    organizationId: string,
    role: string,
    query: { page?: number; limit?: number },
  ) {
    await this.assertEventOwnership(eventId, organizationId);

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const result = await this.eventsRepo.findParties(eventId, { page, limit });

    return PaginatedResponseDto.of(
      EventGuestPartySerializer.toList(result.data, true),
      result.total,
      result.page,
      result.limit,
    );
  }

  async updateParty(
    eventId: string,
    partyId: string,
    organizationId: string,
    adminId: string,
    role: string,
    dto: UpdatePartyDto,
    requestId?: string,
  ) {
    const owned = await this.eventsRepo.verifyPartyOwnership(partyId, eventId, organizationId);
    if (!owned) {
      throw new NotFoundException({
        message: 'Guest party not found',
        errors: { partyId: 'Party does not exist for this event' },
      });
    }

    const party = await this.eventsRepo.updateParty(partyId, eventId, {
      primaryName: dto.primaryName,
      adultsCount: dto.adultsCount,
      childrenCount: dto.childrenCount,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: partyId,
      targetType: 'EventGuestParty',
      action: 'update',
      requestId,
    });

    return EventGuestPartySerializer.toResponse(party, true);
  }

  async deleteParty(
    eventId: string,
    partyId: string,
    organizationId: string,
    adminId: string,
    role: string,
    requestId?: string,
  ) {
    this.assertEventAdmin(role);

    const owned = await this.eventsRepo.verifyPartyOwnership(partyId, eventId, organizationId);
    if (!owned) {
      throw new NotFoundException({
        message: 'Guest party not found',
        errors: { partyId: 'Party does not exist for this event' },
      });
    }

    await this.eventsRepo.deleteParty(partyId, eventId);
    await this.invalidateEventStats(eventId);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: partyId,
      targetType: 'EventGuestParty',
      action: 'delete',
      requestId,
    });
  }

  // ── PERSON DETAILS (name / meal preference) ───────────────────────────────

  async updatePersonDetails(
    eventId: string,
    personId: string,
    organizationId: string,
    dto: { displayName?: string; selectedMealTypeId?: string | null; mealPreference?: string | null },
  ) {
    await this.assertEventOwnership(eventId, organizationId);

    const person = await this.eventsRepo.updatePersonDetails(personId, eventId, dto);
    if (!person) {
      throw new NotFoundException({
        message: 'Person not found',
        errors: { personId: 'Person does not exist for this event' },
      });
    }

    await this.invalidateEventStats(eventId);

    return {
      id: person.id,
      displayName: person.displayName,
      selectedMealTypeId: person.selectedMealTypeId,
      mealPreference: person.mealPreference,
    };
  }

  // ── PERSON PRESENCE ───────────────────────────────────────────────────────

  async updatePersonPresence(
    eventId: string,
    personId: string,
    organizationId: string,
    isPresent: boolean,
  ) {
    await this.assertEventOwnership(eventId, organizationId);

    const person = await this.eventsRepo.updatePersonPresence(personId, eventId, isPresent);
    if (!person) {
      throw new NotFoundException({
        message: 'Person not found',
        errors: { personId: 'Person does not exist for this event' },
      });
    }

    await this.invalidateEventStats(eventId);

    return { id: person.id, isPresent: person.isPresent };
  }

  // ── STATS ─────────────────────────────────────────────────────────────────

  async getEventStats(
    eventId: string,
    organizationId: string,
  ) {
    await this.assertEventOwnership(eventId, organizationId);

    const cacheKey = `event:stats:${eventId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const stats = await this.eventsRepo.computeStats(eventId, organizationId);
    const serialized = EventStatsSerializer.toResponse(stats);

    await this.redis.set(cacheKey, JSON.stringify(serialized), EVENT_STATS_TTL);

    return serialized;
  }

  // ── PRIVATE HELPERS ────────────────────────────────────────────────────────

  private assertEventAdmin(role: string): void {
    if (!EVENT_ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException({
        message: 'Insufficient permissions',
        errors: { role: 'Only event admins and org admins can perform this action' },
      });
    }
  }

  private async assertEventOwnership(
    eventId: string,
    organizationId: string,
  ): Promise<void> {
    const event = await this.eventsRepo.findById(eventId, organizationId);
    if (!event) {
      throw new NotFoundException({
        message: 'Event not found',
        errors: { eventId: 'No event found with this ID in your organization' },
        statusCode: 404,
      });
    }
  }

  private async invalidateEventStats(eventId: string): Promise<void> {
    await this.redis.del(`event:stats:${eventId}`);
  }
}
