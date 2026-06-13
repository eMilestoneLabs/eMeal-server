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
  closedAt: Date | null;   // GAP-EVT-1: admin Close Event timestamp
  archivedAt: Date | null; // GAP-EVT-1: admin Archive Event timestamp
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
    closedAt?: Date | null;
    archivedAt?: Date | null;
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
    this.closedAt = data.closedAt ?? null;
    this.archivedAt = data.archivedAt ?? null;
    this.mealTypes = data.mealTypes ?? [];
    this.guestParties = data.guestParties ?? [];
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * GAP-EVT-1 (RESOLVED): derived event status per Event_admin.md §4 + §18.
   *   archived  — archivedAt set, or soft-deleted (isActive=false): hidden, restorable
   *   expired   — event date has passed: read-only (view/export only)
   *   closed    — admin closed the event before its date: no joins/modifications
   *   upcoming  — open: guests may join, modify attendance + meal selections
   * Additive serializer field — Flutter computes its own EventStatus and
   * ignores unknown JSON keys, so this cannot break the locked contract.
   */
  get status(): 'upcoming' | 'closed' | 'expired' | 'archived' {
    if (this.archivedAt || !this.isActive) return 'archived';
    const endOfEventDay = new Date(this.eventDate);
    endOfEventDay.setUTCHours(23, 59, 59, 999);
    if (Date.now() > endOfEventDay.getTime()) return 'expired';
    if (this.closedAt) return 'closed';
    return 'upcoming';
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
    pending?: number; // attending guests without a meal selection (Event_admin.md §12)
    vegCount: number;
    nonVegCount: number;
    mealTypeBreakdown: Array<{ mealTypeId: string; title: string; count: number }>;
  }) {
    this.eventId = data.eventId;
    this.total = data.total;
    this.adults = data.adults;
    this.children = data.children;
    this.present = data.present;
    // Pending = ATTENDING guests who have not selected a meal yet.
    // Fallback (legacy callers): registered minus attending.
    this.pending = data.pending ?? data.total - data.present;
    this.vegCount = data.vegCount;
    this.nonVegCount = data.nonVegCount;
    this.mealTypeBreakdown = data.mealTypeBreakdown;
  }
}
