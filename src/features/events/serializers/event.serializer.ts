/**
 * EventSerializer — Frontend contract serializer for B5 Events.
 *
 * Contract invariants (from Flutter EventModel.fromJson / EventGuestParty.fromJson):
 *   - date: full ISO string (DateTime in Flutter) — Flutter reads json['date'] (M-15)
 *   - joinCode: serialized from DB joinToken
 *   - adminId: included from Event.adminId
 *   - adminName: required (resolved from User.name in repo JOIN)
 *   - mealTypes: always array (empty if none)
 *   - persons: always array (empty if none)
 *   - EventStats: { total, adults, children, present, pending, vegCount, nonVegCount, mealTypeBreakdown }
 */

import {
  EventEntity,
  EventMealTypeEntity,
  EventGuestPartyEntity,
  EventPersonEntity,
  EventStatsEntity,
} from '../entities/event.entity';

// ─── EventPersonSerializer ────────────────────────────────────────────────────

export class EventPersonSerializer {
  static toResponse(person: EventPersonEntity): Record<string, unknown> {
    return {
      id: person.id,
      partyId: person.partyId,
      displayName: person.displayName,
      isAdult: person.isAdult,
      isPrimary: person.isPrimary,
      isNameEdited: person.isNameEdited,
      isPresent: person.isPresent,
      selectedMealTypeId: person.selectedMealTypeId,
      mealPreference: person.mealPreference,
    };
  }

  static toList(persons: EventPersonEntity[]): Record<string, unknown>[] {
    return persons.map((p) => EventPersonSerializer.toResponse(p));
  }
}

// ─── EventMealTypeSerializer ──────────────────────────────────────────────────

export class EventMealTypeSerializer {
  static toResponse(mt: EventMealTypeEntity): Record<string, unknown> {
    return {
      id: mt.id,
      title: mt.title,
      emoji: mt.emoji,
      colorValue: mt.colorValue,
      isVeg: mt.isVeg,
    };
  }

  static toList(types: EventMealTypeEntity[]): Record<string, unknown>[] {
    return types.map((mt) => EventMealTypeSerializer.toResponse(mt));
  }
}

// ─── EventGuestPartySerializer ────────────────────────────────────────────────

export class EventGuestPartySerializer {
  static toResponse(
    party: EventGuestPartyEntity,
    includePersons = true,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: party.id,
      eventId: party.eventId,
      primaryName: party.primaryName,
      adultsCount: party.adultsCount,
      childrenCount: party.childrenCount,
      joinedAt: party.joinedAt.toISOString(),
    };

    if (includePersons) {
      base.persons = EventPersonSerializer.toList(party.persons);
    }

    return base;
  }

  static toList(
    parties: EventGuestPartyEntity[],
    includePersons = true,
  ): Record<string, unknown>[] {
    return parties.map((p) =>
      EventGuestPartySerializer.toResponse(p, includePersons),
    );
  }
}

// ─── EventSerializer ──────────────────────────────────────────────────────────

export class EventSerializer {
  /**
   * Full event response — includes mealTypes.
   * M-15: Flutter reads json['date'] (not eventDate).
   */
  static toResponse(event: EventEntity): Record<string, unknown> {
    return {
      id: event.id,
      name: event.name,
      type: event.type,
      date: event.eventDate.toISOString(),
      expectedGuestCount: event.expectedGuestCount,
      adminId: event.adminId ?? null,
      adminName: event.adminName,
      joinCode: event.joinCode,
      autoDeleteAfter7Days: event.autoDeleteAfter7Days,
      isActive: event.isActive,
      mealTypes: EventMealTypeSerializer.toList(event.mealTypes),
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    };
  }

  /**
   * List item — excludes guest parties (paginated list performance).
   */
  static toListItem(event: EventEntity): Record<string, unknown> {
    return {
      id: event.id,
      name: event.name,
      type: event.type,
      date: event.eventDate.toISOString(),
      expectedGuestCount: event.expectedGuestCount,
      adminId: event.adminId ?? null,
      adminName: event.adminName,
      joinCode: event.joinCode,
      autoDeleteAfter7Days: event.autoDeleteAfter7Days,
      isActive: event.isActive,
      mealTypeCount: event.mealTypes.length,
      createdAt: event.createdAt.toISOString(),
      updatedAt: event.updatedAt.toISOString(),
    };
  }

  static toList(events: EventEntity[]): Record<string, unknown>[] {
    return events.map((e) => EventSerializer.toListItem(e));
  }
}

// ─── EventStatsSerializer ─────────────────────────────────────────────────────

export class EventStatsSerializer {
  /**
   * Event attendance stats — M-18 contract.
   * Flutter reads: total, adults, children, pending (raw counts only — no rates).
   */
  static toResponse(stats: EventStatsEntity): Record<string, unknown> {
    return {
      total: stats.total,
      adults: stats.adults,
      children: stats.children,
      present: stats.present,
      pending: stats.pending,
      vegCount: stats.vegCount,
      nonVegCount: stats.nonVegCount,
      mealTypeBreakdown: stats.mealTypeBreakdown,
    };
  }
}
