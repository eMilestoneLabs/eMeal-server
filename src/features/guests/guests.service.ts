import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
  UnprocessableEntityException,
  HttpException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../../audit/audit.service';
import { BillingService } from '../billing/billing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NoticesService } from '../notices/notices.service';
import { PreferencesService } from '../preferences/preferences.service';
import type { ValidatedSelections } from '../preferences/preferences.service';
import { MembersRepository } from '../groups/repositories/members.repository';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import {
  toUtcMidnight,
  getCurrentTimeInTimezone,
} from '../../common/utils/date.utils';
import { getVacationCoveredUserIds } from '../../common/utils/vacation-coverage.util';
import {
  BookGuestsDto,
  UpdateGuestDto,
  QueryGuestsDto,
  ReviewGuestDto,
} from './dto/guest.dto';

function todayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Group columns the guest flows need — one shape everywhere. */
const GROUP_SELECT = {
  id: true,
  isActive: true,
  mealsEnabled: true,
  // Live-Test-6 ISSUE-2: planner flags gate the per-day preference override
  // (guest selections validate against the day-effective group set).
  weeklyMenuEnabled: true,
  dayWiseMealsEnabled: true,
  mealPricingEnabled: true,
  preferencesEnabled: true,
  enabledPreferences: true,
  attendanceGraceMinutes: true,
  guestAttendanceEnabled: true,
  maxGuestsPerMemberPerMeal: true,
  maxGuestsPerMemberPerDay: true,
  guestPricingMode: true,
  guestAdultPrice: true,
  guestChildPrice: true,
  guestSurcharge: true,
  guestSurchargeType: true,
  guestRequiresApproval: true,
  guestCutoffMinutesBeforeClose: true,
  guestAdvanceBookingDays: true,
  guestPreferenceRequired: true,
  allowGuestWithoutHost: true,
} as const;

/**
 * GuestsService — Module 22 (Pass 8): Member-Hosted Guests (+N).
 *
 * Governing overlay (FR-FAIR-001): a guest ALWAYS increases the host's
 * liability, so every guest is host-initiated — an admin may add guests only
 * as a pendingApproval booking the HOST must confirm (FR-HG-062).
 *
 * Concurrency (FR-HG-032/044): each booking transaction takes a Postgres
 * advisory xact lock on (host, meal, date), so concurrent bookings serialize
 * and the cap can never be exceeded; a Redis idempotency guard would be
 * redundant on top of it.
 *
 * Counters (FR-HG-012): host AttendanceRecord.guestAdults/guestChildren are
 * RECOMPUTED from the guest table inside the same transaction — drift-proof.
 */
@Injectable()
export class GuestsService {
  private readonly logger = new Logger(GuestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly membersRepo: MembersRepository,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    // command_3: in-app admin bell alert on guest requests (Notification
    // Center). Optional so unit tests run without the notices infra wired.
    @Optional()
    @Inject(NoticesService)
    private readonly notices: NoticesService | null,
    // Same pattern as corrections.service — string token keeps this module
    // decoupled from RealtimeModule; null in unit tests.
    @Optional() @Inject('ATTENDANCE_GATEWAY')
    private readonly gateway: {
      emitToGroup(groupId: string, event: string, payload: unknown): void;
      emitToUser(userId: string, event: string, payload: unknown): void;
      emitToAdmin(organizationId: string, event: string, payload: unknown): void;
    } | null,
    // Live-Test-6 ISSUE-2: per-guest preference-group validation + pricing.
    // LAST + @Optional so existing unit tests construct positionally unchanged.
    @Optional()
    @Inject(PreferencesService)
    private readonly preferences: PreferencesService | null = null,
  ) {}

  /**
   * meal.guest.updated.v1 (FR-HG-063/064, Pass 9) — one versioned event for
   * every hosted-guest mutation. Group room (live kitchen/dashboards) + host
   * user room (their own devices) + admin room (approval queues). Additive,
   * fire-and-forget — never blocks or fails the mutation.
   */
  private emitGuestEvent(payload: {
    organizationId: string;
    groupId: string;
    mealId: string;
    date: string; // YYYY-MM-DD
    hostUserId: string;
    action:
      | 'booked'
      | 'proposed'
      | 'updated'
      | 'cancelled'
      | 'approved'
      | 'confirmed'
      | 'rejected'
      | 'declined'
      | 'auto_cancelled';
    count?: number;
    guestId?: string;
  }): void {
    try {
      this.gateway?.emitToGroup(payload.groupId, 'meal.guest.updated.v1', payload);
      this.gateway?.emitToUser(payload.hostUserId, 'meal.guest.updated.v1', payload);
      this.gateway?.emitToAdmin(payload.organizationId, 'meal.guest.updated.v1', payload);
    } catch (_) {
      /* realtime is best-effort */
    }
  }

  /** Kitchen/dashboard read caches go stale on any guest mutation. */
  private async invalidateKitchenCache(
    organizationId: string,
    groupId: string,
    mealId: string,
    dateUtc: Date,
  ): Promise<void> {
    const dateStr = dateUtc.toISOString().slice(0, 10);
    try {
      await this.redis.del(
        `attendance:meal:${organizationId}:${mealId}:${dateStr}`,
        `attendance:group:${organizationId}:${groupId}:${dateStr}`,
      );
    } catch (_) {
      /* best-effort — TTL covers the rest */
    }
    // Pass 12 (FR-BILLX-050): guest charges feed bills — bump the billing
    // read-cache version (O(1), fire-and-forget).
    void this.billing?.bumpBillingVersion?.(groupId);
  }

  private isAdmin(role: string): boolean {
    return (ADMIN_ROLES as readonly string[]).includes(role);
  }

  // ── BOOK (FR-HG-001/030/031/032/040/041/042/043/044/051/062) ──────────────

  async bookGuests(
    callerId: string,
    callerRole: string,
    organizationId: string,
    mealId: string,
    dto: BookGuestsDto,
    requestId?: string,
  ) {
    const adminOnBehalf =
      this.isAdmin(callerRole) &&
      !!dto.hostUserId &&
      dto.hostUserId !== callerId;
    const hostUserId = adminOnBehalf ? dto.hostUserId! : callerId;

    // Meal + group + org isolation in one query.
    const meal = await this.prisma.meal.findFirst({
      where: { id: mealId, organizationId },
      select: {
        id: true,
        name: true,
        groupId: true,
        price: true,
        attendanceEnabled: true,
        attendanceWindowOpen: true,
        attendanceWindowClose: true,
        group: { select: GROUP_SELECT },
        organization: { select: { timezone: true } },
      },
    });
    if (!meal) throw new NotFoundException('Meal not found');
    const group = meal.group!;

    // Gates: archived group (FR-MEMX-006), feature flag (FR-HG-003),
    // Meal Mode only (FR-HG-004).
    if (!group.isActive) {
      throw new ForbiddenException({
        message: 'Group access is no longer available',
        code: 'GROUP_ARCHIVED',
        errors: { groupId: 'This group has been archived' },
      });
    }
    if (!group.guestAttendanceEnabled) {
      throw new ForbiddenException({
        message: 'Hosted guests are not enabled for this group',
        code: 'GUESTS_DISABLED',
        errors: { mealId: 'Ask your admin to enable guest hosting' },
      });
    }
    if (group.mealsEnabled === false) {
      throw new ForbiddenException({
        message: 'Hosted guests are available only in Meal Mode',
        code: 'GUESTS_REQUIRE_MEALS',
        errors: { mealId: 'This group runs attendance-only mode' },
      });
    }

    // Host eligibility (FR-HG-043): active member, not blocked. The vacation
    // check moved below — it is date/meal-scoped (FR-VACX-003/008).
    await this.assertEligibleHost(group.id, hostUserId);

    // Date bounds (FR-HG-040): today .. today + guestAdvanceBookingDays.
    const tz = meal.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = todayInTimezone(tz);
    const dateStr = dto.attendanceDate;
    const advanceDays = group.guestAdvanceBookingDays ?? 0;
    if (dateStr < todayStr) {
      throw new UnprocessableEntityException({
        message: 'Guests cannot be booked for past dates',
        errors: { attendanceDate: 'Must be today or a future date' },
      });
    }
    const aheadMs =
      toUtcMidnight(dateStr).getTime() - toUtcMidnight(todayStr).getTime();
    if (aheadMs > advanceDays * 24 * 60 * 60 * 1000) {
      throw new UnprocessableEntityException({
        message:
          advanceDays > 0
            ? `Guests can be booked at most ${advanceDays} day(s) in advance`
            : 'Guests can only be booked for today',
        code: 'GUEST_ADVANCE_LIMIT',
        errors: { attendanceDate: 'Beyond the advance-booking window' },
      });
    }

    // Cutoff window for same-day bookings (FR-HG-040/072). Members only —
    // an admin-on-behalf booking still needs host confirmation, which is the
    // stronger control.
    const effective = await this.resolveEffectiveWindow(meal, dateStr);
    if (dateStr === todayStr && !adminOnBehalf) {
      this.assertBeforeCutoff(group, effective.closeTime, tz);
    }

    // FR-DISP-010: no billing writes into a finalized period.
    await this.assertPeriodOpen(organizationId, group.id, dateStr);

    // FR-VACX-008 (Pass 11, slot-aware per FR-VACX-003): a host on vacation
    // for THIS meal/date cannot host guests; on boundary days, meals outside
    // the covered slots stay hostable. Approved dated requests govern; the
    // instant toggle covers whole days.
    const dateUtc = toUtcMidnight(dateStr);
    const hostUser = await this.prisma.user.findUnique({
      where: { id: hostUserId },
      select: { isVacationMode: true },
    });
    const onVacation = await getVacationCoveredUserIds(this.prisma as any, {
      organizationId,
      groupId: group.id,
      dateUtc,
      mealOpenTime: meal.attendanceWindowOpen,
      candidates: [
        { userId: hostUserId, isVacationMode: hostUser?.isVacationMode === true },
      ],
    });
    if (onVacation.has(hostUserId)) {
      throw new ForbiddenException({
        message: 'Guests cannot be hosted while on vacation mode',
        code: 'HOST_ON_VACATION',
        errors: { hostUserId: 'The host is on vacation for this meal' },
      });
    }

    // Host-present precondition (FR-HG-030) — same-day only; future-dated
    // bookings resolve via FR-HG-035 reconciliation when the host marks.
    if (!group.allowGuestWithoutHost && dateStr === todayStr) {
      const hostRecord = await this.prisma.attendanceRecord.findFirst({
        where: { organizationId, userId: hostUserId, mealId, attendanceDate: dateUtc },
        select: { status: true },
      });
      if (hostRecord?.status !== 'present') {
        throw new UnprocessableEntityException({
          message: 'Mark yourself Present for this meal before adding guests',
          code: 'HOST_NOT_PRESENT',
          errors: { mealId: 'Host must be Present (or enable allowGuestWithoutHost)' },
        });
      }
    }

    // Live-Test-6 ISSUE-2: per-guest multi-preference-group picks (FR-PG-*).
    // One effective-group resolution for the meal, then each guest's picks are
    // validated by the SAME server-authoritative validator members use —
    // required groups gate guest booking exactly like a member's Present mark.
    // Validation uses the DAY-EFFECTIVE set (planner override) — the same
    // groups the booking sheet rendered from /meals/today for that date.
    let pgGroups = this.preferences
      ? await this.preferences.getEffectiveGroupsForMeal(mealId, organizationId)
      : [];
    pgGroups = await this.applyGuestDayOverride(
      pgGroups,
      group,
      group.id,
      organizationId,
      mealId,
      dateStr,
    );
    const guestSelections: Array<ValidatedSelections | null> = dto.guests.map(
      (g) =>
        pgGroups.length > 0
          ? this.preferences!.validateSelections(pgGroups, g.selections ?? [])
          : null,
    );

    // Per-guest FLAT preference validation (FR-HG-031/071/081). The required
    // rule is enforceable only when the guest can actually satisfy it:
    //  • no flat options configured (allowed=[])  → nothing to pick (fail-safe,
    //    same philosophy as the veg-only group fail-safe), and
    //  • the meal runs preference GROUPS → the group picks (validated above)
    //    are the guest's meal choice; demanding a legacy flat tag on top made
    //    booking impossible from the sheet (it renders groups, not flat chips).
    const prefRequired = group.guestPreferenceRequired === true;
    const allowed = (group.enabledPreferences ?? []) as string[];
    for (const g of dto.guests) {
      if (
        prefRequired &&
        !g.mealPreference &&
        allowed.length > 0 &&
        pgGroups.length === 0
      ) {
        throw new UnprocessableEntityException({
          message: 'A meal preference is required for every guest',
          code: 'GUEST_PREFERENCE_REQUIRED',
          errors: { guests: 'Select a preference for each guest' },
        });
      }
      if (g.mealPreference && allowed.length > 0 && !allowed.includes(g.mealPreference)) {
        throw new UnprocessableEntityException({
          message: `Preference '${g.mealPreference}' is not enabled for this group`,
          errors: { guests: `Allowed: ${allowed.join(', ')}` },
        });
      }
    }

    // Pricing (FR-HG-013/051): snapshot at booking; headcount-only when
    // pricing is off.
    const priceFor = (isAdult: boolean): number | null =>
      this.resolveGuestPrice(group, effective.price, isAdult);
    // Preference price deltas are stored in paise; guest prices are whole ₹ —
    // same unit boundary as attendance marking (single conversion point).
    const priceWithDelta = (
      isAdult: boolean,
      v: ValidatedSelections | null,
    ): number | null => {
      const base = priceFor(isAdult);
      if (base == null || v == null) return base;
      return base + Math.round(v.totalDelta / 100);
    };

    // Admin-on-behalf (FR-HG-062) and approval workflow (FR-HG-042) both park
    // the booking as pendingApproval — cleared by host-confirm or admin-approve.
    const pendingApproval = adminOnBehalf || group.guestRequiresApproval === true;

    const capPerMeal = group.maxGuestsPerMemberPerMeal ?? 5;
    const capPerDay = group.maxGuestsPerMemberPerDay ?? null;

    // ── Atomic booking (FR-HG-032/041/044) ───────────────────────────────────
    const lockKey = `guest:${hostUserId}:${mealId}:${dateStr}`;
    const created = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent bookings for the same host/meal/date.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const [mealCount, dayCount] = await Promise.all([
        tx.mealGuest.count({
          where: {
            organizationId,
            hostUserId,
            mealId,
            attendanceDate: dateUtc,
            status: 'booked',
          },
        }),
        capPerDay !== null
          ? tx.mealGuest.count({
              where: {
                organizationId,
                hostUserId,
                groupId: group.id,
                attendanceDate: dateUtc,
                status: 'booked',
              },
            })
          : Promise.resolve(0),
      ]);

      if (mealCount + dto.guests.length > capPerMeal) {
        throw new UnprocessableEntityException({
          message: `Guest limit reached — up to ${capPerMeal} guests per meal`,
          code: 'GUEST_LIMIT_REACHED',
          errors: { guests: `Remaining allowance: ${Math.max(0, capPerMeal - mealCount)}` },
        });
      }
      if (capPerDay !== null && dayCount + dto.guests.length > capPerDay) {
        throw new UnprocessableEntityException({
          message: `Daily guest limit reached — up to ${capPerDay} guests per day`,
          code: 'GUEST_LIMIT_REACHED',
          errors: { guests: `Remaining today: ${Math.max(0, capPerDay - dayCount)}` },
        });
      }

      const rows = dto.guests.map((g, i) => ({
        organizationId,
        groupId: group.id,
        mealId,
        attendanceDate: dateUtc,
        hostUserId,
        isAdult: g.isAdult ?? true,
        displayName: g.displayName ?? null,
        // Group-pick meals derive the flat tag from the primary selection —
        // exactly how member marking derives it (keeps veg/non-veg analytics).
        mealPreference:
          g.mealPreference ?? guestSelections[i]?.primaryKey ?? null,
        // Immutable per-guest selection snapshot (Live-Test-6 ISSUE-2).
        preferences:
          guestSelections[i] && guestSelections[i]!.snapshot.length > 0
            ? (guestSelections[i]!.snapshot as any)
            : undefined,
        status: 'booked',
        pendingApproval,
        priceSnapshot: priceWithDelta(g.isAdult ?? true, guestSelections[i]),
        createdBy: callerId,
        ...(pendingApproval ? {} : { approvedBy: null }),
      }));
      await tx.mealGuest.createMany({ data: rows });

      // FR-HG-012: recompute denormalised host counters in-transaction.
      await this.recomputeHostCounters(tx, organizationId, hostUserId, mealId, dateUtc);

      return tx.mealGuest.findMany({
        where: {
          organizationId,
          hostUserId,
          mealId,
          attendanceDate: dateUtc,
          status: 'booked',
        },
        orderBy: { createdAt: 'asc' },
      });
    });

    await this.invalidateKitchenCache(organizationId, group.id, mealId, dateUtc);
    this.emitGuestEvent({
      organizationId,
      groupId: group.id,
      mealId,
      date: dateStr,
      hostUserId,
      action: pendingApproval ? 'proposed' : 'booked',
      count: dto.guests.length,
    });

    this.audit.log({
      organizationId,
      actorId: callerId,
      targetId: mealId,
      targetType: 'MealGuest',
      action: AuditAction.create,
      metadata: {
        hostUserId,
        dateStr,
        added: dto.guests.length,
        pendingApproval,
        ...(adminOnBehalf ? { adminOnBehalf: true } : {}),
      },
      requestId,
    });

    // command_3: a member-requested guest booking that needs admin approval
    // surfaces in the admin bell (Notification Center), deep-linked to review.
    if (pendingApproval && !adminOnBehalf && this.notices) {
      void this.notices.createRequestAlert({
        organizationId,
        groupId: group.id,
        actorId: hostUserId,
        title: 'New guest meal request',
        body: `A member requested ${dto.guests.length} guest(s) for ${meal.name}. Tap to review.`,
        priority: 'high',
        linkType: 'guestRequests',
      });
    }

    // Notifications: pending admin approval → admins; admin-added → host.
    if (adminOnBehalf) {
      void this.notifications.notifyAttendanceChanged({
        organizationId,
        userId: hostUserId,
        newStatus: `${dto.guests.length} guest(s) proposed for ${meal.name}`,
        dateStr,
        reason: 'Confirm to accept the guest charge',
        changedBy: 'admin',
      });
    }

    const booked = created.filter((g) => !g.pendingApproval);
    const estimated = booked.reduce((s, g) => s + (g.priceSnapshot ?? 0), 0);
    return {
      hostUserId,
      mealId,
      attendanceDate: dateStr,
      guests: created.map((g) => this.toResponse(g)),
      counters: {
        guestAdults: booked.filter((g) => g.isAdult).length,
        guestChildren: booked.filter((g) => !g.isAdult).length,
        pendingApproval: created.filter((g) => g.pendingApproval).length,
      },
      estimatedGuestCost: estimated,
    };
  }

  // ── LIST (FR-HG-080) ───────────────────────────────────────────────────────

  async listGuests(
    requesterId: string,
    requesterRole: string,
    organizationId: string,
    query: QueryGuestsDto,
  ) {
    const admin = this.isAdmin(requesterRole);
    const where: Record<string, unknown> = { organizationId };
    if (!admin) where.hostUserId = requesterId; // members see only their own
    else if (query.hostUserId) where.hostUserId = query.hostUserId;
    if (query.groupId) where.groupId = query.groupId;
    if (query.mealId) where.mealId = query.mealId;
    if (query.date) where.attendanceDate = toUtcMidnight(query.date);

    const rows = await this.prisma.mealGuest.findMany({
      where: where as any,
      orderBy: [{ attendanceDate: 'desc' }, { createdAt: 'asc' }],
      take: 200,
    });

    // Live-Test-5 ISSUE-2 (Guest Attendance Visibility policy): the admin
    // Attendance tab renders guests as first-class rows — each row must name
    // its HOST and MEAL without client-side joins. Two batched IN() lookups
    // (never N+1), additive fields only.
    const hostIds = [...new Set(rows.map((g) => g.hostUserId))];
    const mealIds = [...new Set(rows.map((g) => g.mealId))];
    const [hosts, meals] =
      rows.length > 0
        ? await Promise.all([
            this.prisma.user.findMany({
              where: { id: { in: hostIds } },
              select: { id: true, name: true },
            }),
            this.prisma.meal.findMany({
              where: { id: { in: mealIds } },
              select: { id: true, name: true },
            }),
          ])
        : [[], []];
    const hostName = new Map(hosts.map((h) => [h.id, h.name]));
    const mealName = new Map(meals.map((m) => [m.id, m.name]));

    return {
      data: rows.map((g) => ({
        ...this.toResponse(g),
        hostName: hostName.get(g.hostUserId) ?? null,
        mealName: mealName.get(g.mealId) ?? null,
      })),
    };
  }

  // ── EDIT (FR-HG-033) ───────────────────────────────────────────────────────

  async updateGuest(
    callerId: string,
    callerRole: string,
    organizationId: string,
    id: string,
    dto: UpdateGuestDto,
    requestId?: string,
  ) {
    const { guest, meal } = await this.loadGuestWithMeal(id, organizationId);
    if (guest.hostUserId !== callerId && !this.isAdmin(callerRole)) {
      throw new ForbiddenException('Only the host may edit this guest');
    }
    if (guest.status !== 'booked') {
      throw new BadRequestException({
        message: 'Only booked guests can be edited',
        errors: { id: `Guest is ${guest.status}` },
      });
    }
    // Members respect the cutoff; admins may fix names/prefs anytime.
    if (!this.isAdmin(callerRole)) {
      await this.assertGuestWindowOpenForDate(meal, guest.attendanceDate);
    }
    if (dto.mealPreference !== undefined && dto.mealPreference !== null) {
      const allowed = (meal.group?.enabledPreferences ?? []) as string[];
      if (allowed.length > 0 && !allowed.includes(dto.mealPreference)) {
        throw new UnprocessableEntityException({
          message: `Preference '${dto.mealPreference}' is not enabled for this group`,
          errors: { mealPreference: `Allowed: ${allowed.join(', ')}` },
        });
      }
    }

    // Live-Test-6 ISSUE-2: replace the guest's preference-group picks. The
    // new set is validated against the meal's CURRENT effective groups; the
    // priceSnapshot is re-derived exactly — old delta out, new delta in — so
    // the booking-time base price is never re-quoted (FR-HG-051 immutability).
    let selectionData: Record<string, unknown> = {};
    if (dto.selections !== undefined && this.preferences) {
      let pgGroups = await this.preferences.getEffectiveGroupsForMeal(
        guest.mealId,
        organizationId,
      );
      // Day-effective set for the guest's booked date (same rule as booking).
      pgGroups = await this.applyGuestDayOverride(
        pgGroups,
        meal.group ?? null,
        meal.groupId,
        organizationId,
        guest.mealId,
        guest.attendanceDate.toISOString().slice(0, 10),
      );
      if (pgGroups.length > 0) {
        const validated = this.preferences.validateSelections(
          pgGroups,
          dto.selections ?? [],
        );
        const oldSnapshot: any[] = Array.isArray(guest.preferences)
          ? (guest.preferences as any[])
          : [];
        let oldDeltaPaise = 0;
        for (const s of oldSnapshot) {
          oldDeltaPaise +=
            (Number(s?.priceDelta) || 0) * (Number(s?.quantity) || 1);
        }
        selectionData = {
          preferences:
            validated.snapshot.length > 0 ? (validated.snapshot as any) : [],
          // Live-Test-7 ISSUE-2 (FR-PG-100 parity with booking): when the
          // picks change and the caller sent no explicit flat tag, re-derive
          // the primary display tag from the new picks — otherwise the row
          // keeps advertising an option the guest no longer has.
          ...(dto.mealPreference === undefined
            ? { mealPreference: validated.primaryKey ?? null }
            : {}),
          ...(guest.priceSnapshot != null
            ? {
                priceSnapshot:
                  guest.priceSnapshot -
                  Math.round(oldDeltaPaise / 100) +
                  Math.round(validated.totalDelta / 100),
              }
            : {}),
        };
      }
    }

    const updated = await this.prisma.mealGuest.update({
      where: { id },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.mealPreference !== undefined ? { mealPreference: dto.mealPreference } : {}),
        ...selectionData,
      },
    });
    this.audit.log({
      organizationId,
      actorId: callerId,
      targetId: id,
      targetType: 'MealGuest',
      action: AuditAction.update,
      metadata: { edited: Object.keys(dto) },
      requestId,
    });
    this.emitGuestEvent({
      organizationId,
      groupId: updated.groupId,
      mealId: updated.mealId,
      date: updated.attendanceDate.toISOString().slice(0, 10),
      hostUserId: updated.hostUserId,
      action: 'updated',
      guestId: id,
    });
    return this.toResponse(updated);
  }

  // ── CANCEL (FR-HG-033/052) ─────────────────────────────────────────────────

  async cancelGuest(
    callerId: string,
    callerRole: string,
    organizationId: string,
    id: string,
    requestId?: string,
  ) {
    const { guest, meal } = await this.loadGuestWithMeal(id, organizationId);
    const admin = this.isAdmin(callerRole);
    if (guest.hostUserId !== callerId && !admin) {
      throw new ForbiddenException('Only the host may cancel this guest');
    }
    if (guest.status !== 'booked') {
      throw new BadRequestException({
        message: 'Guest is already cancelled',
        errors: { id: `Guest is ${guest.status}` },
      });
    }
    // Hosts respect the cutoff; admins may cancel any time (a cancellation
    // only DECREASES the host's liability — FR-FAIR-001 permits it).
    if (!admin) {
      await this.assertGuestWindowOpenForDate(meal, guest.attendanceDate);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.mealGuest.update({
        where: { id },
        data: { status: 'cancelled', cancelledBy: callerId, cancelledAt: new Date() },
      });
      await this.recomputeHostCounters(
        tx, organizationId, guest.hostUserId, guest.mealId, guest.attendanceDate,
      );
      return u;
    });
    await this.invalidateKitchenCache(
      organizationId, guest.groupId, guest.mealId, guest.attendanceDate,
    );

    this.audit.log({
      organizationId,
      actorId: callerId,
      targetId: id,
      targetType: 'MealGuest',
      action: AuditAction.update,
      metadata: {
        decision: 'cancelled',
        hostUserId: guest.hostUserId,
        ...(admin && guest.hostUserId !== callerId ? { byAdmin: true } : {}),
      },
      requestId,
    });
    // FR-TRUST-011: host hears about admin cancellations.
    if (admin && guest.hostUserId !== callerId) {
      void this.notifications.notifyAttendanceChanged({
        organizationId,
        userId: guest.hostUserId,
        newStatus: 'guest cancelled',
        dateStr: guest.attendanceDate.toISOString().slice(0, 10),
        reason: null,
        changedBy: 'admin',
      });
    }
    this.emitGuestEvent({
      organizationId,
      groupId: guest.groupId,
      mealId: guest.mealId,
      date: guest.attendanceDate.toISOString().slice(0, 10),
      hostUserId: guest.hostUserId,
      action: 'cancelled',
      guestId: id,
    });
    return this.toResponse(updated);
  }

  // ── APPROVE / REJECT (admin, FR-HG-042) · CONFIRM (host, FR-HG-062) ───────

  async approveGuest(
    adminId: string,
    organizationId: string,
    id: string,
    _dto: ReviewGuestDto,
    requestId?: string,
  ) {
    const { guest } = await this.loadGuestWithMeal(id, organizationId);
    this.assertPendingBooked(guest);
    // An ADMIN-created guest awaits the HOST's consent, not another admin's
    // (FR-FAIR-001 — admin identity ≠ member identity).
    if (guest.createdBy !== guest.hostUserId) {
      throw new BadRequestException({
        message: 'This guest awaits the host’s confirmation, not admin approval',
        errors: { id: 'Host must confirm' },
      });
    }
    return this.clearPending(adminId, organizationId, guest, 'approved', requestId);
  }

  async rejectGuest(
    adminId: string,
    organizationId: string,
    id: string,
    dto: ReviewGuestDto,
    requestId?: string,
  ) {
    const { guest } = await this.loadGuestWithMeal(id, organizationId);
    this.assertPendingBooked(guest);
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.mealGuest.update({
        where: { id },
        data: { status: 'cancelled', cancelledBy: adminId, cancelledAt: new Date() },
      });
      await this.recomputeHostCounters(
        tx, organizationId, guest.hostUserId, guest.mealId, guest.attendanceDate,
      );
      return u;
    });
    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'MealGuest',
      action: AuditAction.update,
      metadata: { decision: 'rejected', note: dto.note ?? null },
      requestId,
    });
    this.emitGuestEvent({
      organizationId,
      groupId: updated.groupId,
      mealId: guest.mealId,
      date: guest.attendanceDate.toISOString().slice(0, 10),
      hostUserId: guest.hostUserId,
      action: 'rejected',
      guestId: id,
    });
    return this.toResponse(updated);
  }

  /** Host confirms an admin-proposed guest (FR-HG-062 consent artifact). */
  async confirmGuest(
    hostId: string,
    organizationId: string,
    id: string,
    requestId?: string,
  ) {
    const { guest } = await this.loadGuestWithMeal(id, organizationId);
    this.assertPendingBooked(guest);
    if (guest.hostUserId !== hostId) {
      throw new ForbiddenException('Only the host can confirm this guest');
    }
    if (guest.createdBy === guest.hostUserId) {
      throw new BadRequestException({
        message: 'This guest awaits admin approval, not host confirmation',
        errors: { id: 'Admin must approve' },
      });
    }
    return this.clearPending(hostId, organizationId, guest, 'confirmed', requestId);
  }

  /** Host declines an admin-proposed guest — cancelled, never billed. */
  async declineGuest(
    hostId: string,
    organizationId: string,
    id: string,
    requestId?: string,
  ) {
    const { guest } = await this.loadGuestWithMeal(id, organizationId);
    this.assertPendingBooked(guest);
    if (guest.hostUserId !== hostId) {
      throw new ForbiddenException('Only the host can decline this guest');
    }
    const updated = await this.prisma.mealGuest.update({
      where: { id },
      data: { status: 'cancelled', cancelledBy: hostId, cancelledAt: new Date() },
    });
    this.auditDecision(organizationId, hostId, id, 'declined', requestId);
    this.emitGuestEvent({
      organizationId,
      groupId: updated.groupId,
      mealId: guest.mealId,
      date: guest.attendanceDate.toISOString().slice(0, 10),
      hostUserId: guest.hostUserId,
      action: 'declined',
      guestId: id,
    });
    return this.toResponse(updated);
  }

  // ── FR-HG-035: host-absent reconciliation (called from attendance writes) ─

  /**
   * When a host's attendance flips AWAY from Present, booked guests are
   * cancelled with the host (default policy) unless the group allows
   * hostless guests. Returns how many were cancelled so the write path can
   * surface it. Never throws — reconciliation must not fail the mark.
   */
  async reconcileOnHostChange(params: {
    organizationId: string;
    groupId: string;
    hostUserId: string;
    mealId: string;
    attendanceDate: Date;
    newStatus: string;
    actorId: string;
    requestId?: string;
  }): Promise<number> {
    try {
      if (params.newStatus === 'present') return 0;
      const group = await this.prisma.group.findUnique({
        where: { id: params.groupId },
        select: { allowGuestWithoutHost: true, guestAttendanceEnabled: true },
      });
      if (!group?.guestAttendanceEnabled || group.allowGuestWithoutHost) return 0;

      const cancelled = await this.prisma.$transaction(async (tx) => {
        const result = await tx.mealGuest.updateMany({
          where: {
            organizationId: params.organizationId,
            hostUserId: params.hostUserId,
            mealId: params.mealId,
            attendanceDate: params.attendanceDate,
            status: 'booked',
          },
          data: {
            status: 'cancelled',
            cancelledBy: params.actorId,
            cancelledAt: new Date(),
          },
        });
        if (result.count > 0) {
          await this.recomputeHostCounters(
            tx,
            params.organizationId,
            params.hostUserId,
            params.mealId,
            params.attendanceDate,
          );
        }
        return result.count;
      });

      if (cancelled > 0) {
        await this.invalidateKitchenCache(
          params.organizationId,
          params.groupId,
          params.mealId,
          params.attendanceDate,
        );
        this.audit.log({
          organizationId: params.organizationId,
          actorId: params.actorId,
          targetId: params.mealId,
          targetType: 'MealGuest',
          action: AuditAction.update,
          metadata: {
            decision: 'auto-cancelled-with-host',
            hostUserId: params.hostUserId,
            count: cancelled,
            newHostStatus: params.newStatus,
          },
          requestId: params.requestId,
        });
        this.emitGuestEvent({
          organizationId: params.organizationId,
          groupId: params.groupId,
          mealId: params.mealId,
          date: params.attendanceDate.toISOString().slice(0, 10),
          hostUserId: params.hostUserId,
          action: 'auto_cancelled',
          count: cancelled,
        });
      }
      return cancelled;
    } catch (err) {
      this.logger.error(
        `Guest reconciliation failed host=${params.hostUserId} meal=${params.mealId}: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  // ── Aggregations for kitchen & billing (FR-HG-050/060/061) ────────────────

  /** Kitchen counts for one (meal, date): booked, approved guests only. */
  async getMealGuestCounts(
    organizationId: string,
    mealId: string,
    dateUtc: Date,
  ) {
    const rows = await this.prisma.mealGuest.findMany({
      where: {
        organizationId,
        mealId,
        attendanceDate: dateUtc,
        status: 'booked',
        pendingApproval: false,
      },
      select: { isAdult: true, mealPreference: true },
    });
    const byPreference: Record<string, number> = {};
    for (const g of rows) {
      const key = g.mealPreference ?? 'unspecified';
      byPreference[key] = (byPreference[key] ?? 0) + 1;
    }
    return {
      guestCount: rows.length,
      guestAdults: rows.filter((g) => g.isAdult).length,
      guestChildren: rows.filter((g) => !g.isAdult).length,
      guestPreferenceBreakdown: byPreference,
    };
  }

  /**
   * Per-host billed guest totals for a group/date-range (booked + approved;
   * no-shows follow billNoShowGuests — LOOP-013).
   */
  async getGuestBillingByHost(
    organizationId: string,
    groupId: string,
    fromDate: Date,
    toDate: Date,
    billNoShow: boolean,
  ): Promise<Map<string, { guestCount: number; guestAmount: number }>> {
    const statuses = billNoShow ? ['booked', 'no_show'] : ['booked'];
    const rows = await this.prisma.mealGuest.groupBy({
      by: ['hostUserId'],
      where: {
        organizationId,
        groupId,
        attendanceDate: { gte: fromDate, lte: toDate },
        status: { in: statuses },
        pendingApproval: false,
      },
      _count: { _all: true },
      _sum: { priceSnapshot: true },
    });
    return new Map(
      rows.map((r) => [
        r.hostUserId,
        { guestCount: r._count._all, guestAmount: r._sum.priceSnapshot ?? 0 },
      ]),
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async assertEligibleHost(groupId: string, hostUserId: string) {
    const membership = await this.membersRepo.findMembership(groupId, hostUserId);
    if (membership?.status === 'blocked') {
      throw new ForbiddenException({
        message: 'You have been blocked from this group',
        code: 'MEMBER_BLOCKED',
        errors: { hostUserId: 'Blocked members cannot host guests' },
      });
    }
    if (!membership || membership.status !== 'active') {
      throw new ForbiddenException({
        message: 'The host is not an active member of this group',
        errors: { hostUserId: 'Active membership required' },
      });
    }
    // Vacation is validated in bookGuests — it is (date, meal)-scoped since
    // Pass 11 (FR-VACX-003): boundary days block only the covered slots.
  }

  /** Effective window/price: published per-day entry overrides the master. */
  /**
   * Live-Test-6 ISSUE-2: narrow the master preference groups to the DAY's
   * published override (same rule /meals/today renders and markAttendance now
   * validates with). Exact-date entry first, else the recurring weekday
   * fallback — mirroring the today overlay. Runs ONLY when the group runs a
   * planner mode AND the meal actually has groups (plain meals pay nothing).
   * Pref-fields-only lookup: the guest money path (cutoff/price) is untouched.
   */
  private async applyGuestDayOverride(
    pgGroups: Awaited<
      ReturnType<PreferencesService['getEffectiveGroupsForMeal']>
    >,
    group: {
      weeklyMenuEnabled?: boolean | null;
      dayWiseMealsEnabled?: boolean | null;
    } | null,
    groupId: string,
    organizationId: string,
    mealId: string,
    dateStr: string,
  ) {
    if (!this.preferences || pgGroups.length === 0) return pgGroups;
    const plannerOn =
      group?.weeklyMenuEnabled === true || group?.dayWiseMealsEnabled === true;
    if (!plannerOn) return pgGroups;
    const dateUtc = toUtcMidnight(dateStr);
    const dow = (dateUtc.getUTCDay() + 6) % 7;
    const entrySelect = {
      preferencesEnabled: true,
      enabledPreferenceGroupIds: true,
    } as const;
    // Both lookups are group+org scoped — never another tenant's schedule.
    let entry = await this.prisma.scheduleEntry.findFirst({
      where: {
        mealId,
        date: dateUtc,
        schedule: { groupId, organizationId, isPublished: true },
      },
      select: entrySelect,
    });
    if (!entry) {
      entry = await this.prisma.scheduleEntry.findFirst({
        where: {
          mealId,
          dayOfWeek: dow,
          schedule: { groupId, organizationId, isPublished: true },
        },
        orderBy: { schedule: { weekStart: 'desc' } },
        select: entrySelect,
      });
    }
    if (!entry) return pgGroups;
    return this.preferences.applyDayOverride(pgGroups, entry);
  }

  private async resolveEffectiveWindow(
    meal: {
      id: string;
      groupId: string;
      price: number | null;
      attendanceWindowOpen: string | null;
      attendanceWindowClose: string | null;
    },
    dateStr: string,
  ): Promise<{ closeTime: string | null; price: number | null }> {
    const entry = await this.prisma.scheduleEntry.findFirst({
      where: {
        mealId: meal.id,
        date: toUtcMidnight(dateStr),
        schedule: { groupId: meal.groupId, isPublished: true },
      },
      select: { openTime: true, closeTime: true, price: true },
    });
    return {
      closeTime: entry?.openTime ? entry.closeTime : meal.attendanceWindowClose,
      price: entry?.price != null ? entry.price : meal.price,
    };
  }

  private assertBeforeCutoff(
    group: { guestCutoffMinutesBeforeClose: number | null; attendanceGraceMinutes: number | null },
    closeTime: string | null,
    tz: string,
  ): void {
    if (!closeTime) return; // unbounded meal — no cutoff to enforce
    const cutoffMin = group.guestCutoffMinutesBeforeClose ?? 0;
    const nowMin = hhmmToMinutes(getCurrentTimeInTimezone(tz));
    const cutoffAt = hhmmToMinutes(closeTime) - cutoffMin;
    if (nowMin >= cutoffAt) {
      throw new HttpException(
        {
          message: `Guest booking closed — cutoff is ${cutoffMin} min before the window close (${closeTime})`,
          code: 'GUEST_WINDOW_CLOSED',
          errors: { attendanceDate: `Cutoff passed for ${closeTime}` },
          serverTime: new Date().toISOString(),
          statusCode: 423,
        },
        423,
      );
    }
  }

  /**
   * Cutoff guard for edit/cancel on an already-loaded guest (FR-HG-072).
   * Uses the EFFECTIVE close (published per-day override else master) — the
   * same boundary the booking path enforces.
   */
  private async assertGuestWindowOpenForDate(
    meal: {
      id: string;
      groupId: string;
      price: number | null;
      attendanceWindowOpen: string | null;
      attendanceWindowClose: string | null;
      group: {
        guestCutoffMinutesBeforeClose: number | null;
        attendanceGraceMinutes: number | null;
      } | null;
      organization: { timezone: string | null } | null;
    },
    attendanceDate: Date,
  ): Promise<void> {
    const tz = meal.organization?.timezone ?? 'Asia/Kolkata';
    const dateStr = attendanceDate.toISOString().slice(0, 10);
    const todayStr = todayInTimezone(tz);
    if (dateStr > todayStr) return; // future-dated — always editable
    if (dateStr < todayStr) {
      throw new HttpException(
        {
          message: 'Guest booking closed for past dates',
          code: 'GUEST_WINDOW_CLOSED',
          errors: { id: 'Ask an admin for corrections' },
          serverTime: new Date().toISOString(),
          statusCode: 423,
        },
        423,
      );
    }
    const effective = await this.resolveEffectiveWindow(meal, dateStr);
    this.assertBeforeCutoff(
      meal.group ?? { guestCutoffMinutesBeforeClose: 0, attendanceGraceMinutes: 0 },
      effective.closeTime,
      tz,
    );
  }

  private resolveGuestPrice(
    group: {
      mealPricingEnabled: boolean;
      guestPricingMode: string | null;
      guestAdultPrice: number | null;
      guestChildPrice: number | null;
      guestSurcharge: number | null;
      guestSurchargeType?: string | null;
    },
    effectiveMealPrice: number | null,
    isAdult: boolean,
  ): number | null {
    if (!group.mealPricingEnabled) return null; // headcount only
    const mode = group.guestPricingMode ?? 'sameAsMember';
    if (mode === 'perGuestPrice') {
      return isAdult
        ? (group.guestAdultPrice ?? effectiveMealPrice)
        : (group.guestChildPrice ?? group.guestAdultPrice ?? effectiveMealPrice);
    }
    if (mode === 'flatSurcharge') {
      const base = effectiveMealPrice ?? 0;
      // SRS Module 03 GST-011: the surcharge is a Fixed ₹ amount (default) OR
      // a Percentage of the final effective member price — never both.
      if ((group.guestSurchargeType ?? 'fixed') === 'percent') {
        return base + Math.round((base * (group.guestSurcharge ?? 0)) / 100);
      }
      return base + (group.guestSurcharge ?? 0);
    }
    return effectiveMealPrice; // sameAsMember
  }

  /** Recompute FR-HG-012 counters from the table (drift-proof). */
  private async recomputeHostCounters(
    tx: {
      mealGuest: { count: (args: any) => Promise<number> };
      attendanceRecord: { updateMany: (args: any) => Promise<unknown> };
    },
    organizationId: string,
    hostUserId: string,
    mealId: string,
    dateUtc: Date,
  ): Promise<void> {
    const base = {
      organizationId,
      hostUserId,
      mealId,
      attendanceDate: dateUtc,
      status: 'booked',
      pendingApproval: false,
    };
    const [adults, children] = await Promise.all([
      tx.mealGuest.count({ where: { ...base, isAdult: true } }),
      tx.mealGuest.count({ where: { ...base, isAdult: false } }),
    ]);
    await tx.attendanceRecord.updateMany({
      where: { organizationId, userId: hostUserId, mealId, attendanceDate: dateUtc },
      data: { guestAdults: adults, guestChildren: children },
    });
  }

  private async assertPeriodOpen(
    organizationId: string,
    groupId: string,
    dateStr: string,
  ): Promise<void> {
    const { locked, periodEnd } = await this.billing.isDateFinalized(
      organizationId,
      groupId,
      toUtcMidnight(dateStr),
    );
    if (locked) {
      throw new HttpException(
        {
          message: 'This billing period is finalized — guest changes are locked',
          code: 'PERIOD_FINALIZED',
          errors: { attendanceDate: `Locked through ${periodEnd}` },
          serverTime: new Date().toISOString(),
          statusCode: 423,
        },
        423,
      );
    }
  }

  private async loadGuestWithMeal(id: string, organizationId: string) {
    const guest = await this.prisma.mealGuest.findFirst({
      where: { id, organizationId },
    });
    if (!guest) throw new NotFoundException('Guest not found');
    const meal = await this.prisma.meal.findFirst({
      where: { id: guest.mealId, organizationId },
      select: {
        id: true,
        groupId: true,
        price: true,
        attendanceWindowOpen: true,
        attendanceWindowClose: true,
        group: {
          select: {
            guestCutoffMinutesBeforeClose: true,
            attendanceGraceMinutes: true,
            enabledPreferences: true,
            // Live-Test-6 ISSUE-2: planner flags gate the day override on edit.
            weeklyMenuEnabled: true,
            dayWiseMealsEnabled: true,
          },
        },
        organization: { select: { timezone: true } },
      },
    });
    if (!meal) throw new NotFoundException('Meal not found');
    return { guest, meal };
  }

  private assertPendingBooked(guest: { status: string; pendingApproval: boolean }) {
    if (guest.status !== 'booked' || !guest.pendingApproval) {
      throw new BadRequestException({
        message: 'Only pending booked guests can be decided',
        errors: { id: `Guest is ${guest.status}${guest.pendingApproval ? '' : ' (not pending)'}` },
      });
    }
  }

  private async clearPending(
    actorId: string,
    organizationId: string,
    guest: {
      id: string;
      hostUserId: string;
      mealId: string;
      attendanceDate: Date;
    },
    decision: 'approved' | 'confirmed',
    requestId?: string,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.mealGuest.update({
        where: { id: guest.id },
        data: { pendingApproval: false, approvedBy: actorId, approvedAt: new Date() },
      });
      await this.recomputeHostCounters(
        tx, organizationId, guest.hostUserId, guest.mealId, guest.attendanceDate,
      );
      return u;
    });
    await this.invalidateKitchenCache(
      organizationId, updated.groupId, guest.mealId, guest.attendanceDate,
    );
    this.auditDecision(organizationId, actorId, guest.id, decision, requestId);
    this.emitGuestEvent({
      organizationId,
      groupId: updated.groupId,
      mealId: guest.mealId,
      date: guest.attendanceDate.toISOString().slice(0, 10),
      hostUserId: guest.hostUserId,
      action: decision,
      guestId: guest.id,
    });
    return this.toResponse(updated);
  }

  private auditDecision(
    organizationId: string,
    actorId: string,
    targetId: string,
    decision: string,
    requestId?: string,
  ): void {
    this.audit.log({
      organizationId,
      actorId,
      targetId,
      targetType: 'MealGuest',
      action: AuditAction.update,
      metadata: { decision },
      requestId,
    });
  }

  private toResponse(g: {
    id: string;
    groupId: string;
    mealId: string;
    attendanceDate: Date;
    hostUserId: string;
    isAdult: boolean;
    displayName: string | null;
    mealPreference: string | null;
    preferences?: unknown;
    status: string;
    pendingApproval: boolean;
    priceSnapshot: number | null;
    createdBy: string;
    createdAt: Date;
  }) {
    return {
      id: g.id,
      groupId: g.groupId,
      mealId: g.mealId,
      attendanceDate: g.attendanceDate.toISOString().slice(0, 10),
      hostUserId: g.hostUserId,
      isAdult: g.isAdult,
      displayName: g.displayName,
      mealPreference: g.mealPreference,
      // Live-Test-6 ISSUE-2 (additive): per-guest preference-group snapshot —
      // [{groupId, groupLabel, optionKey, optionLabel, isVeg, priceDelta, quantity}].
      preferences: Array.isArray(g.preferences) ? g.preferences : null,
      status: g.status,
      pendingApproval: g.pendingApproval,
      priceSnapshot: g.priceSnapshot,
      createdBy: g.createdBy,
      createdAt: g.createdAt.toISOString(),
    };
  }
}
