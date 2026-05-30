/**
 * Event domain entities — B5 Phase.
 *
 * Separation: Prisma model → Domain Entity → Serializer → DTO Response.
 * Prisma models are NEVER returned directly from service/controller layer.
 */

// ─── EventPersonEntity ────────────────────────────────────────────────────────

export class EventPersonEntity {
  id: string;
  partyId: string;
  displayName: string;
  isAdult: boolean;
  isPrimary: boolean;
  isNameEdited: boolean;
  isPresent: boolean;
  selectedMealTypeId: string | null;
  mealPreference: string | null;
  createdAt: Date;

  constructor(data: {
    id: string;
    partyId: string;
    displayName: string;
    isAdult: boolean;
    isPrimary: boolean;
    isNameEdited: boolean;
    isPresent: boolean;
    selectedMealTypeId?: string | null;
    mealPreference?: string | null;
    createdAt: Date;
  }) {
    this.id = data.id;
    this.partyId = data.partyId;
    this.displayName = data.displayName;
    this.isAdult = data.isAdult;
    this.isPrimary = data.isPrimary;
    this.isNameEdited = data.isNameEdited;
    this.isPresent = data.isPresent;
    this.selectedMealTypeId = data.selectedMealTypeId ?? null;
    this.mealPreference = data.mealPreference ?? null;
    this.createdAt = data.createdAt;
  }
}

// ─── EventMealTypeEntity ──────────────────────────────────────────────────────

export class EventMealTypeEntity {
  id: string;
  eventId: string;
  title: string;
  emoji: string | null;
  colorValue: number | null;
  isVeg: boolean;
  createdAt: Date;

  constructor(data: {
    id: string;
    eventId: string;
    title: string;
    emoji?: string | null;
    colorValue?: number | null;
    isVeg: boolean;
    createdAt: Date;
  }) {
    this.id = data.id;
    this.eventId = data.eventId;
    this.title = data.title;
    this.emoji = data.emoji ?? null;
    this.colorValue = data.colorValue ?? null;
    this.isVeg = data.isVeg;
    this.createdAt = data.createdAt;
  }
}

// ─── EventGuestPartyEntity ────────────────────────────────────────────────────

export class EventGuestPartyEntity {
  id: string;
  eventId: string;
  primaryName: string;
  adultsCount: number;
  childrenCount: number;
  joinedAt: Date;
  persons: EventPersonEntity[];

  constructor(data: {
    id: string;
    eventId: string;
    primaryName: string;
    adultsCount: number;
    childrenCount: number;
    joinedAt: Date;
    persons?: EventPersonEntity[];
  }) {
    this.id = data.id;
    this.eventId = data.eventId;
    this.primaryName = data.primaryName;
    this.adultsCount = data.adultsCount;
    this.childrenCount = data.childrenCount;
    this.joinedAt = data.joinedAt;
    this.persons = data.persons ?? [];
  }
}

// ─── EventEntity ──────────────────────────────────────────────────────────────

export class EventEntity {
  id: string;
  organizationId: string;
  adminId: string;
  adminName: string; // resolved from User.name
  name: string;
  type: string;
  eventDate: Date;
  expectedGuestCount: number;
  joinCode: string; // serialized from joinToken
  autoDeleteAfter7Days: boolean;
  autoDeleteAt: Date | null;
  isActive: boolean;
  mealTypes: EventMealTypeEntity[];
  guestParties: EventGuestPartyEntity[];
  createdAt: Date;
  updatedAt: Date;

  constructor(data: {
    id: string;
    organizationId: string;
    adminId: string;
    adminName: string;
    name: string;
    type: string;
    eventDate: Date;
    expectedGuestCount: number;
    joinCode: string;
    autoDeleteAfter7Days: boolean;
    autoDeleteAt?: Date | null;
    isActive: boolean;
    mealTypes?: EventMealTypeEntity[];
    guestParties?: EventGuestPartyEntity[];
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = data.id;
    this.organizationId = data.organizationId;
    this.adminId = data.adminId;
    this.adminName = data.adminName;
    this.name = data.name;
    this.type = data.type;
    this.eventDate = data.eventDate;
    this.expectedGuestCount = data.expectedGuestCount;
    this.joinCode = data.joinCode;
    this.autoDeleteAfter7Days = data.autoDeleteAfter7Days;
    this.autoDeleteAt = data.autoDeleteAt ?? null;
    this.isActive = data.isActive;
    this.mealTypes = data.mealTypes ?? [];
    this.guestParties = data.guestParties ?? [];
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }
}

// ─── EventStatsEntity ─────────────────────────────────────────────────────────

export class EventStatsEntity {
  eventId: string;
  total: number;    // total persons across all parties
  adults: number;
  children: number;
  present: number;
  pending: number;  // total - present
  vegCount: number;
  nonVegCount: number;
  mealTypeBreakdown: Array<{ mealTypeId: string; title: string; count: number }>;

  constructor(data: {
    eventId: string;
    total: number;
    adults: number;
    children: number;
    present: number;
    vegCount: number;
    nonVegCount: number;
    mealTypeBreakdown: Array<{ mealTypeId: string; title: string; count: number }>;
  }) {
    this.eventId = data.eventId;
    this.total = data.total;
    this.adults = data.adults;
    this.children = data.children;
    this.present = data.present;
    this.pending = data.total - data.present;
    this.vegCount = data.vegCount;
    this.nonVegCount = data.nonVegCount;
    this.mealTypeBreakdown = data.mealTypeBreakdown;
  }
}
