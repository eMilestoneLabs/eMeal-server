/**
 * event.serializer.spec.ts — B5 Phase
 *
 * Contract tests for EventSerializer, EventMealTypeSerializer,
 * EventGuestPartySerializer, EventPersonSerializer, EventStatsSerializer.
 *
 * These tests verify the EXACT JSON shape expected by Flutter's EventModel.fromJson.
 * Any field rename = contract break = Flutter crash.
 */

import {
  EventSerializer,
  EventMealTypeSerializer,
  EventGuestPartySerializer,
  EventPersonSerializer,
  EventStatsSerializer,
} from '../serializers/event.serializer';
import {
  EventEntity,
  EventMealTypeEntity,
  EventGuestPartyEntity,
  EventPersonEntity,
  EventStatsEntity,
} from '../entities/event.entity';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date('2026-01-15T10:00:00.000Z');

const mockMealType = new EventMealTypeEntity({
  id: 'mt-1',
  eventId: 'ev-1',
  title: 'Veg Thali',
  emoji: '🥗',
  colorValue: 0xFF4CAF50,
  isVeg: true,
  createdAt: now,
});

const mockPerson = new EventPersonEntity({
  id: 'p-1',
  partyId: 'party-1',
  displayName: 'Rahul Mahanta',
  isAdult: true,
  isPrimary: true,
  isNameEdited: true,
  isPresent: false,
  selectedMealTypeId: 'mt-1',
  mealPreference: 'veg',
  createdAt: now,
});

const mockParty = new EventGuestPartyEntity({
  id: 'party-1',
  eventId: 'ev-1',
  primaryName: 'Rahul Mahanta',
  adultsCount: 3,
  childrenCount: 2,
  joinedAt: now,
  persons: [mockPerson],
});

const mockEvent = new EventEntity({
  id: 'ev-1',
  organizationId: 'org-1',
  adminId: 'admin-1',
  adminName: 'Sonali Mahanta',
  name: 'Annual Dinner',
  type: 'corporate',
  eventDate: now,
  expectedGuestCount: 50,
  joinCode: 'join-token-abc123',
  autoDeleteAfter7Days: false,
  autoDeleteAt: null,
  isActive: true,
  mealTypes: [mockMealType],
  guestParties: [mockParty],
  createdAt: now,
  updatedAt: now,
});

const mockStats = new EventStatsEntity({
  eventId: 'ev-1',
  total: 5,
  adults: 3,
  children: 2,
  present: 2,
  vegCount: 3,
  nonVegCount: 1,
  mealTypeBreakdown: [{ mealTypeId: 'mt-1', title: 'Veg Thali', count: 3 }],
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EventPersonSerializer', () => {
  it('serializes all required fields', () => {
    const result = EventPersonSerializer.toResponse(mockPerson);

    // M-17 contract: displayName NOT name, selectedMealTypeId NOT mealTypeId, mealPreference NOT preference
    expect(result).toHaveProperty('id', 'p-1');
    expect(result).toHaveProperty('partyId', 'party-1');
    expect(result).toHaveProperty('displayName', 'Rahul Mahanta');
    expect(result).toHaveProperty('isAdult', true);
    expect(result).toHaveProperty('isPrimary', true);
    expect(result).toHaveProperty('isNameEdited', true);
    expect(result).toHaveProperty('isPresent', false);
    expect(result).toHaveProperty('selectedMealTypeId', 'mt-1');
    expect(result).toHaveProperty('mealPreference', 'veg');

    // Forbidden field names
    expect(result).not.toHaveProperty('name');
    expect(result).not.toHaveProperty('mealTypeId');
    expect(result).not.toHaveProperty('preference');
  });
});

describe('EventMealTypeSerializer', () => {
  it('serializes all required fields', () => {
    const result = EventMealTypeSerializer.toResponse(mockMealType);

    // M-14 contract: title NOT name, emoji, colorValue (ARGB32 integer)
    expect(result).toHaveProperty('id', 'mt-1');
    expect(result).toHaveProperty('title', 'Veg Thali');
    expect(result).toHaveProperty('emoji', '🥗');
    expect(result).toHaveProperty('colorValue', 0xFF4CAF50);
    expect(result).toHaveProperty('isVeg', true);

    // Forbidden field names
    expect(result).not.toHaveProperty('name');
    expect(result).not.toHaveProperty('color');
  });
});

describe('EventGuestPartySerializer', () => {
  it('serializes all required fields with persons', () => {
    const result = EventGuestPartySerializer.toResponse(mockParty, true);

    // M-16 contract: primaryName, adultsCount NOT adultCount, childrenCount NOT childCount
    expect(result).toHaveProperty('id', 'party-1');
    expect(result).toHaveProperty('eventId', 'ev-1');
    expect(result).toHaveProperty('primaryName', 'Rahul Mahanta');
    expect(result).toHaveProperty('adultsCount', 3);
    expect(result).toHaveProperty('childrenCount', 2);
    expect(result).toHaveProperty('joinedAt');
    expect(result).toHaveProperty('persons');

    // Forbidden field names
    expect(result).not.toHaveProperty('adultCount');
    expect(result).not.toHaveProperty('childCount');

    // joinedAt is ISO string
    expect(typeof result.joinedAt).toBe('string');
    expect(result.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('persons array nested correctly', () => {
    const result = EventGuestPartySerializer.toResponse(mockParty, true);
    expect(Array.isArray(result.persons)).toBe(true);
    const persons = result.persons as any[];
    expect(persons).toHaveLength(1);
    expect(persons[0]).toHaveProperty('displayName', 'Rahul Mahanta');
  });
});

describe('EventSerializer', () => {
  it('toResponse serializes all required fields', () => {
    const result = EventSerializer.toResponse(mockEvent);

    expect(result).toHaveProperty('id', 'ev-1');
    expect(result).toHaveProperty('name', 'Annual Dinner');
    expect(result).toHaveProperty('type', 'corporate');
    expect(result).toHaveProperty('eventDate');
    expect(result).toHaveProperty('adminName', 'Sonali Mahanta'); // REQUIRED
    expect(result).toHaveProperty('joinCode', 'join-token-abc123');
    expect(result).toHaveProperty('autoDeleteAfter7Days', false);
    expect(result).toHaveProperty('isActive', true);
    expect(result).toHaveProperty('mealTypes');
    expect(result).toHaveProperty('createdAt');
    expect(result).toHaveProperty('updatedAt');

    // adminName is required — never null/undefined
    expect(result.adminName).toBeTruthy();

    // eventDate is full ISO string (not date-only)
    expect(typeof result.eventDate).toBe('string');
    expect(result.eventDate as string).toMatch(/T\d{2}:\d{2}:\d{2}/);
  });

  it('mealTypes is always an array', () => {
    const result = EventSerializer.toResponse(mockEvent);
    expect(Array.isArray(result.mealTypes)).toBe(true);
  });

  it('toListItem omits guestParties for performance', () => {
    const result = EventSerializer.toListItem(mockEvent);
    expect(result).not.toHaveProperty('guestParties');
    expect(result).toHaveProperty('mealTypeCount', 1);
  });

  it('does NOT expose internal DB fields', () => {
    const result = EventSerializer.toResponse(mockEvent);
    expect(result).not.toHaveProperty('joinToken');        // internal DB field
    expect(result).not.toHaveProperty('organizationId');   // not needed by Flutter
    expect(result).not.toHaveProperty('adminId');
  });
});

describe('EventStatsSerializer', () => {
  it('serializes all required count fields', () => {
    const result = EventStatsSerializer.toResponse(mockStats);

    expect(result).toHaveProperty('total', 5);
    expect(result).toHaveProperty('adults', 3);
    expect(result).toHaveProperty('children', 2);
    expect(result).toHaveProperty('present', 2);
    expect(result).toHaveProperty('pending', 3); // 5 - 2
    expect(result).toHaveProperty('vegCount', 3);
    expect(result).toHaveProperty('nonVegCount', 1);
    expect(result).toHaveProperty('mealTypeBreakdown');

    // No rates/percentages — Flutter computes
    expect(result).not.toHaveProperty('presentRate');
    expect(result).not.toHaveProperty('absentRate');
  });

  it('pending is computed as total - present', () => {
    const result = EventStatsSerializer.toResponse(mockStats);
    expect(result.pending).toBe((result.total as number) - (result.present as number));
  });
});
