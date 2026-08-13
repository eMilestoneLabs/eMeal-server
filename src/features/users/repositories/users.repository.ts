import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { UserEntity } from '../entities/user.entity';
import { UserRole } from '@prisma/client';
import {
  getTodayInTimezone,
  toUtcMidnight,
} from '../../../common/utils/date.utils';
import { splitVacationTargets } from '../../../common/utils/vacation-coverage.util';

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build UserEntity from a Prisma User record that already has
   * `members` included via Prisma include clause.
   * Using include on the parent query eliminates the N+1 pattern
   * where buildEntity() previously fired one GroupMember query per user.
   */
  private buildEntityFromInclude(user: any): UserEntity {
    const activeMembers = (user.groupMembers ?? []).filter(
      (m: any) => m.status === 'active',
    );
    const groupIds = activeMembers.map((m: any) => m.groupId);
    return new UserEntity({
      ...user,
      groupIds,
      groupId: groupIds[0] ?? null,
      // ISSUE-001 (additive): membership briefs with real group names +
      // per-group functional role for the client's group switcher.
      groups: activeMembers.map((m: any) => ({
        id: m.groupId,
        name: m.group?.name ?? '',
        role: m.functionalRole ?? null,
      })),
    });
  }

  /** Include clause reused across all single-record finders. */
  private get memberInclude() {
    return {
      groupMembers: {
        where: { status: 'active' as const },
        select: {
          groupId: true,
          status: true,
          // ISSUE-001: group name + per-group role for the switcher labels.
          functionalRole: true,
          // Per-group vacation state. FREE — one more column on an include
          // this finder already makes. It lets the read-time sync decide
          // whether a write is even needed, preserving command_6's rule that
          // the common no-flip profile load costs ZERO extra queries.
          isVacationMode: true,
          group: { select: { name: true } },
        },
      },
    };
  }

  async findById(id: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  /**
   * Pass 11 (FR-VACX-006): read-time vacation flag sync, org-timezone-correct.
   * Called on GET /users/me so the flag is right the moment the app opens —
   * the lifecycle sweep covers users who never open the app.
   *
   * Rules (two vacation modes, FR-VACX-001):
   *   • An approved request covers today (org time) and the flag is OFF →
   *     flip ON (future-dated approval reaching its start date).
   *   • The flag is ON, the user HAS approved requests, and none covers
   *     today → flip OFF (auto-resume the day after endDate, org time).
   *   • Pure-toggle users (no approved requests at all) are NEVER touched —
   *     the instant toggle is its own mode and must not silently die.
   *
   * Currently UNREACHABLE — `GET /auth/me` uses the bundled
   * {@link resolveVacationFlagPrefetched} (command_6), and a repo grep finds
   * no production caller. It is KEPT (never delete a working path) and is now
   * SCOPE-AWARE like the other writers, so wiring it up again can never
   * re-introduce the account-level spill.
   */
  async syncVacationExpiry(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isVacationMode: true,
        organization: { select: { timezone: true } },
      },
    });
    if (!user) return;

    const tz = user.organization?.timezone ?? 'Asia/Kolkata';
    const todayUtc = toUtcMidnight(getTodayInTimezone(tz));

    const coveringRequests = await this.prisma.vacationRequest.findMany({
      where: {
        userId,
        status: 'approved',
        deletedAt: null,
        startDate: { lte: todayUtc },
        endDate: { gte: todayUtc },
      },
      // `groupId` decides WHERE the state belongs — same free column, same
      // shared rule as the other two writers.
      select: { id: true, groupId: true },
    });
    const { orgLevel, groupIds } = splitVacationTargets(coveringRequests);

    // GROUP-SCOPED requests activate their own membership. `not: true` keeps
    // it idempotent while still re-activating a group the member once returned
    // early from (identical guard to resolveVacationFlagPrefetched).
    if (groupIds.length > 0) {
      // TENANT ISOLATION: no organizationId predicate is needed here and its
      // absence is not an oversight. `groupIds` is derived from THIS user's own
      // approved requests (the query above is `userId`-pinned), and a request's
      // groupId is validated against the member's own membership at creation.
      // The write is additionally pinned to `userId`, so it can only ever touch
      // this user's own membership rows — never another user's, never another
      // organization's.
      await this.prisma.groupMember.updateMany({
        where: { userId, groupId: { in: groupIds }, isVacationMode: { not: true } },
        data: { isVacationMode: true },
      });
    }

    // Only an ORG-LEVEL covering request may raise the ACCOUNT flag.
    if (orgLevel && !user.isVacationMode) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { isVacationMode: true },
      });
      return;
    }
    // ACCOUNT-flag resume. Gated on ORG-LEVEL coverage only, mirroring the
    // FR-VACX-006 sweep: `User.isVacationMode` means ORG-WIDE leave, so a
    // group-scoped request must never hold it open — an expired org-level
    // vacation would then stay switched on merely because an unrelated
    // group's vacation had started, re-creating the cross-group spill.
    if (!orgLevel && user.isVacationMode) {
      // Only request-driven flags auto-resume; toggle-mode flags stay.
      // ORG-LEVEL only, for the same reason.
      const hasAnyApproved = await this.prisma.vacationRequest.findFirst({
        where: { userId, status: 'approved', deletedAt: null, groupId: null },
        select: { id: true },
      });
      if (hasAnyApproved) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { isVacationMode: false },
        });
      }
    }
  }

  /**
   * command_6 perf: GET /users/me bundle — the profile row (memberships + org
   * timezone) AND the near-today approved vacation rows in ONE parallel wave,
   * so the common profile load costs a single DB round trip instead of the
   * three sequential ones (sync user fetch → covering fetch → full findById).
   *
   * The vacation rows are fetched with a ±48h margin around "now" and the
   * exact covering check (org-timezone today) is evaluated in process. Any
   * approved request covering today's org-local date necessarily intersects
   * that margin window (org midnight is within ±24h of now for every
   * timezone), so this is equivalent to the covering findFirst in
   * {@link syncVacationExpiry}.
   */
  async findByIdWithVacationMeta(id: string): Promise<{
    entity: UserEntity;
    orgTimezone: string;
    approvedNearToday: {
      startDate: Date;
      endDate: Date;
      // Additive, and FREE: one more column on a select this query already
      // makes. It carries WHICH group a covering request belongs to, so the
      // caller can tell the client that a group-scoped vacation does not apply
      // to the member's other groups (resolveVacationScopeGroupIds).
      groupId: string | null;
    }[];
    /** groupId -> this member's per-group vacation value (null = inherit). */
    memberVacation: Map<string, boolean | null>;
  } | null> {
    const marginMs = 48 * 60 * 60 * 1000;
    const now = Date.now();
    const [user, approvedNearToday] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        include: {
          ...this.memberInclude,
          organization: { select: { timezone: true } },
        },
      }),
      this.prisma.vacationRequest.findMany({
        where: {
          userId: id,
          status: 'approved',
          deletedAt: null,
          startDate: { lte: new Date(now + marginMs) },
          endDate: { gte: new Date(now - marginMs) },
        },
        select: { startDate: true, endDate: true, groupId: true },
      }),
    ]);
    if (!user) return null;
    const { organization, ...rest } = user as any;
    return {
      entity: this.buildEntityFromInclude(rest),
      orgTimezone: organization?.timezone ?? 'Asia/Kolkata',
      approvedNearToday,
      memberVacation: new Map(
        ((rest.groupMembers ?? []) as any[]).map((m) => [
          m.groupId as string,
          (m.isVacationMode ?? null) as boolean | null,
        ]),
      ),
    };
  }

  /**
   * command_6 perf: identical vacation-flag rules to {@link syncVacationExpiry}
   * (flip ON when an approved request covers today; flip OFF only for
   * request-driven flags; never touch pure-toggle users) — but fed by the
   * prefetched bundle, so the no-flip common case costs ZERO extra queries and
   * a flip never re-reads the user row. Returns the resolved flag.
   */
  async resolveVacationFlagPrefetched(
    userId: string,
    isVacationMode: boolean,
    orgTimezone: string,
    approvedNearToday: { startDate: Date; endDate: Date; groupId?: string | null }[],
    // Per-group state from the SAME bundle (groupId -> value, null = inherit).
    // Omitted by callers that have no membership context; the org-level rules
    // below are then byte-identical to the behaviour before group scoping.
    memberVacation?: Map<string, boolean | null>,
  ): Promise<boolean> {
    const todayUtc = toUtcMidnight(getTodayInTimezone(orgTimezone));
    const coveringRequests = approvedNearToday.filter(
      (r) => r.startDate <= todayUtc && r.endDate >= todayUtc,
    );

    // WHERE the state belongs. An ORG-LEVEL request keeps writing the account
    // flag exactly as before; a GROUP-SCOPED one writes only its membership,
    // because the account bit has no room for scope and using it marked the
    // member on vacation in every group they belong to.
    const { orgLevel, groupIds } = splitVacationTargets(coveringRequests);

    // Activate the group-scoped memberships a covering request governs.
    //
    // The guard is "not already TRUE", never "is NULL". A per-group Return
    // Early leaves the row at explicit `false`, and a LATER approved request
    // for that same group must still be able to activate it — the account-flag
    // path has always recovered that way (`covering && !isVacationMode`).
    // Narrowing this to NULL would strand the member off-vacation for every
    // future request in a group they once returned early from.
    //
    // Return Early is protected by the REQUEST being ended, not by the column
    // value: setVacationMode calls endCoveringVacationRequests for this group
    // AND org-level requests, so no covering request survives to re-activate.
    //
    // `not: true` also keeps the hot path clean — an already-active membership
    // matches nothing, so a profile load during a vacation issues NO write.
    if (memberVacation) {
      const toActivate = groupIds.filter((g) => memberVacation.get(g) !== true);
      if (toActivate.length > 0) {
        // Tenant isolation by derivation — see the note in syncVacationExpiry:
        // groupIds come from this user's OWN requests and the write is
        // userId-pinned, so no cross-user or cross-org row is reachable.
        await this.prisma.groupMember.updateMany({
          where: {
            userId,
            groupId: { in: toActivate },
            isVacationMode: { not: true },
          },
          data: { isVacationMode: true },
        });
      }
    }

    // Only an ORG-LEVEL covering request may raise the account flag now.
    if (orgLevel && !isVacationMode) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { isVacationMode: true },
      });
      return true;
    }
    // Group-scoped resume: a membership activated by a request that has now
    // ENDED goes back to NULL (inherit) — never `false`, which would be an
    // explicit override permanently shadowing later org-wide vacations.
    // Gated by the SAME "recently ended" rule as the account flag (LT-8
    // ISSUE-007): without it, a member's own per-group toggle would be
    // force-cleared, which is precisely the bug that exposed members to
    // auto-Present billing mid-vacation.
    if (memberVacation) {
      const endedRecently = approvedNearToday.filter(
        (r) => r.endDate.getTime() < todayUtc.getTime(),
      );
      const stillCovered = new Set(groupIds);
      const toResume = splitVacationTargets(endedRecently)
        .groupIds.filter(
          (g) => !stillCovered.has(g) && memberVacation.get(g) === true,
        );
      if (toResume.length > 0) {
        await this.prisma.groupMember.updateMany({
          where: { userId, groupId: { in: toResume }, isVacationMode: true },
          data: { isVacationMode: null },
        });
      }
    }

    // ACCOUNT-flag resume — ORG-LEVEL requests only, mirroring the FR-VACX-006
    // sweep. `User.isVacationMode` means ORG-WIDE leave, so a GROUP-scoped
    // request must never hold it open: an expired org-level vacation would
    // otherwise stay switched on merely because an unrelated group's vacation
    // had started, spilling org-wide leave into every group.
    if (!orgLevel && isVacationMode) {
      // Only request-driven flags auto-resume; toggle-mode flags stay.
      // Live-Test-8 ISSUE-007: "request-driven" = an approved request that
      // JUST ENDED (inside the prefetch's ±48h margin). The old "any approved
      // request ever" fallback force-cleared MANUAL toggle vacations for
      // members with historical requests — exposing them to auto-Present
      // billing mid-vacation. A recently-ended request is the only legitimate
      // auto-resume trigger; anything older means the flag is toggle-driven
      // and stays until the member turns it off.
      // ORG-LEVEL only, for the same reason as the guard above.
      const recentlyEnded = approvedNearToday.some(
        (r) => r.groupId == null && r.endDate.getTime() < todayUtc.getTime(),
      );
      if (recentlyEnded) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { isVacationMode: false },
        });
        return false;
      }
    }
    return isVacationMode;
  }

  /**
   * SRS Module 03 VAC-005/006/012 (BUG-VAC-SELF-SERVE): Return Early.
   * Turning vacation OFF must PERSIST — but syncVacationExpiry force-flips the
   * flag back ON while an approved request still covers today. Ending the
   * covering request(s) is the only durable OFF: the vacation record itself
   * ends at the return point, so no read-time sync or lifecycle sweep can
   * re-enable it. Approval mode is deliberately NOT consulted — Return Early
   * is always self-service (VAC-005), even in approval mode.
   *
   *   • Request started before today → shorten: endDate = yesterday (history
   *     keeps the days actually taken; today's remaining meals reactivate).
   *   • Request starting today → cancel outright (no day was consumed; a
   *     zero-length approved range cannot be represented).
   *
   * Future-dated approved requests are untouched — they are separate
   * vacations, not the one being returned from. Returns the ended request ids
   * so the caller can audit the action (VAC-013).
   */
  async endCoveringVacationRequests(
    userId: string,
    // Optional GROUP scope for Return Early. Omitted (every existing caller)
    // keeps the historical behaviour verbatim: every covering request ends,
    // matching the org-wide toggle that triggered it. Supplied, only THIS
    // group's requests — plus org-level ones, which genuinely cover it — are
    // ended, so returning early from one group cannot silently truncate a
    // separately-approved vacation in another.
    groupId?: string,
  ): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { organization: { select: { timezone: true } } },
    });
    if (!user) return [];

    const tz = user.organization?.timezone ?? 'Asia/Kolkata';
    const todayUtc = toUtcMidnight(getTodayInTimezone(tz));

    const covering = await this.prisma.vacationRequest.findMany({
      where: {
        userId,
        status: 'approved',
        deletedAt: null,
        startDate: { lte: todayUtc },
        endDate: { gte: todayUtc },
        // Same scoping rule the coverage util applies (FR-VACX-001): an
        // org-level request (groupId null) governs every group, so ending
        // this group's vacation must end it too.
        ...(groupId ? { OR: [{ groupId }, { groupId: null }] } : {}),
      },
      select: { id: true, startDate: true },
    });
    if (covering.length === 0) return [];

    const yesterdayUtc = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);
    await this.prisma.$transaction(
      covering.map((r) =>
        r.startDate.getTime() < todayUtc.getTime()
          ? this.prisma.vacationRequest.update({
              where: { id: r.id },
              data: { endDate: yesterdayUtc },
            })
          : this.prisma.vacationRequest.update({
              where: { id: r.id },
              data: { status: 'cancelled', reviewedAt: new Date() },
            }),
      ),
    );
    return covering.map((r) => r.id);
  }

  /**
   * Pass 11 (FR-VACX-001): does any of the user's active groups require the
   * dated-request approval flow (instant toggle disabled)?
   */
  /**
   * Resolve a CLIENT-SUPPLIED groupId to a membership the target user actually
   * holds, inside the caller's organization. Returns null when the id is not
   * an active membership of that user in that org — so a caller can never
   * address another tenant's or another member's group by guessing an id.
   *
   * One indexed point read on the existing (groupId, userId) unique.
   */
  async findActiveMembershipId(
    userId: string,
    groupId: string,
    organizationId: string,
  ): Promise<string | null> {
    const hit = await this.prisma.groupMember.findFirst({
      where: {
        userId,
        groupId,
        status: 'active',
        // Tenant isolation through the relation, plus the same archived-group
        // re-check every other state-changing flow makes at submit: an
        // archived group runs no meals, so a per-group setting written to one
        // is inert — but it SURVIVES a restore, which is exactly the "silently
        // resumes on return" hazard the rejoin paths reset to NULL to avoid.
        // `vacationRequiresApproval` already required isActive; this aligns.
        group: { organizationId, isActive: true },
      },
      select: { id: true },
    });
    return hit?.id ?? null;
  }

  /**
   * Per-group Personal Auto-Attendance (ATT-010). Writes the membership row
   * only — `User.isDefaultAttendance` is left untouched so it keeps serving as
   * the inherited default for every group that has no explicit value.
   */
  async setMemberDefaultAttendance(
    userId: string,
    groupId: string,
    organizationId: string,
    enabled: boolean,
  ): Promise<boolean> {
    const { count } = await this.prisma.groupMember.updateMany({
      where: {
        userId,
        groupId,
        status: 'active',
        // Tenant isolation + the archived-group re-check (see
        // findActiveMembershipId). Same clause on both, so the validate and
        // the write can never disagree about which groups are writable.
        group: { organizationId, isActive: true },
      },
      data: { isDefaultAttendance: enabled },
    });
    return count > 0;
  }

  /**
   * Per-group vacation state. Same contract as
   * {@link setMemberDefaultAttendance}: membership row only, user flag
   * untouched. `null` restores "inherit the user-level flag".
   */
  async setMemberVacationMode(
    userId: string,
    groupId: string,
    organizationId: string,
    value: boolean | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.groupMember.updateMany({
      where: {
        userId,
        groupId,
        status: 'active',
        // Same clause as the other two (see findActiveMembershipId).
        group: { organizationId, isActive: true },
      },
      data: { isVacationMode: value },
    });
    return count > 0;
  }

  /**
   * ORG-WIDE vacation write (no group scope) — the admin-forced toggle and the
   * historical self-service one.
   *
   * It must be AUTHORITATIVE. `resolveMemberFlag` is `member ?? user`, so an
   * explicit per-group value beats the user flag by design (that is how a
   * per-group Return Early works). The side effect was that once a member had
   * used the per-group toggle, that column stayed non-NULL forever and an
   * admin forcing vacation org-wide got a 200 plus a "turned ON by your admin"
   * push while THAT group carried on billing them.
   *
   * Clearing the overrides back to NULL restores inheritance, so the org-wide
   * value genuinely governs every group again — which is what "org-wide" means
   * and what the migration note promised.
   *
   * ONE round trip: `$transaction([...])` pipelines both statements, so this
   * costs no extra wave versus the single `update` it replaces. The
   * `not: null` predicate means the second statement touches only rows that
   * actually carry an override — usually zero.
   *
   * Only `isVacationMode` is cleared. Auto-attendance has no org-wide toggle
   * and is a separate member preference; wiping it here would destroy a
   * setting the actor never addressed.
   */
  async setVacationModeOrgWide(userId: string, enabled: boolean) {
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { isVacationMode: enabled },
      }),
      this.prisma.groupMember.updateMany({
        where: { userId, isVacationMode: { not: null } },
        data: { isVacationMode: null },
      }),
    ]);
    return user;
  }

  async vacationRequiresApproval(
    userId: string,
    // Optional GROUP scope. Omitted (the org-wide toggle) keeps the historical
    // rule verbatim: ANY of the member's groups demanding approval blocks the
    // instant toggle. Supplied, only THAT group's policy decides — a group
    // that does not require approval must not inherit another group's gate.
    groupId?: string,
  ): Promise<boolean> {
    const hit = await this.prisma.groupMember.findFirst({
      where: {
        ...(groupId ? { groupId } : {}),
        userId,
        status: 'active',
        group: { isActive: true, vacationRequiresApproval: true },
      },
      select: { groupId: true },
    });
    return !!hit;
  }

  /** fcmToken for fire-and-forget notifications (LOOP-041). */
  async getPushTarget(
    userId: string,
  ): Promise<{ userId: string; fcmToken: string; organizationId: string | null } | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true, organizationId: true },
    });
    return u?.fcmToken
      ? { userId, fcmToken: u.fcmToken, organizationId: u.organizationId }
      : null;
  }

  /**
   * UNI-035 (uniqueness audit): an FCM device token belongs to exactly ONE
   * active account. Registering it for `userId` releases it from every other
   * user in the same transaction, so a device that switches accounts never
   * receives another account's pushes (and group broadcasts never hit the
   * same physical device twice).
   */
  async claimFcmToken(userId: string, token: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { fcmToken: token, id: { not: userId } },
        data: { fcmToken: null },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { fcmToken: token },
      }),
    ]);
  }

  /**
   * Emails are matched CASE-INSENSITIVELY everywhere (login, signup dup-check,
   * password reset). Rows created before 2026-07-04 may store mixed case
   * (e.g. "Manas.B…@gmail.com"), so exact matching locked users out when they
   * typed lowercase. Writes normalize to lowercase via normalizeEmail below.
   */
  private static emailWhere(email: string) {
    return { email: { equals: email.trim(), mode: 'insensitive' as const } };
  }

  private static normalizeEmail<T extends string | undefined>(email: T): T {
    return (email ? email.trim().toLowerCase() : email) as T;
  }

  async findByEmail(email: string, organizationId?: string): Promise<UserEntity | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        ...UsersRepository.emailWhere(email),
        ...(organizationId ? { organizationId } : {}),
      },
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  async findByPhone(phone: string, organizationId?: string): Promise<UserEntity | null> {
    // UNI-002: matches canonical + legacy "+91"/"91"/"0" stored variants so
    // the signup duplicate check can never be bypassed by formatting.
    const user = await this.prisma.user.findFirst({
      where: {
        ...UsersRepository.phoneWhere(phone),
        ...(organizationId ? { organizationId } : {}),
      },
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  /**
   * UNI-002 (Live-Test-5 ISSUE-6): phone lookups match every stored format of
   * the same real number. New rows store the canonical 10-digit form, but the
   * signup DTO historically also accepted "+91…"/"0…" — legacy rows in those
   * shapes must stay reachable for login AND must still trip the duplicate
   * check. Indexed IN() of ≤3 literals — same cost class as the equality.
   */
  private static phoneWhere(phone: string) {
    const p = phone.trim();
    const variants = new Set([p]);
    if (/^[6-9]\d{9}$/.test(p)) {
      variants.add(`+91${p}`);
      variants.add(`91${p}`);
      variants.add(`0${p}`);
    }
    return { phone: { in: [...variants] } };
  }

  async findByIdentifier(identifier: string): Promise<UserEntity | null> {
    const isEmail = identifier.includes('@');
    const user = await this.prisma.user.findFirst({
      where: isEmail
        ? UsersRepository.emailWhere(identifier)
        : UsersRepository.phoneWhere(identifier),
      include: this.memberInclude,
    });
    if (!user) return null;
    return this.buildEntityFromInclude(user);
  }

  async create(data: {
    name: string;
    email?: string;
    phone?: string;
    passwordHash?: string;
    role: UserRole;
    gender?: string;
    age?: number;
    organizationId?: string;
    loginPreference?: string;
  }): Promise<UserEntity> {
    const user = await this.prisma.user.create({
      data: { ...data, email: UsersRepository.normalizeEmail(data.email) },
      include: this.memberInclude,
    });
    return this.buildEntityFromInclude(user);
  }

  async update(id: string, data: Partial<{
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    gender: string;
    age: number;
    avatarUrl: string;
    isVacationMode: boolean;
    isDefaultAttendance: boolean;
    remindersEnabled: boolean;
    loginPreference: string;
    fcmToken: string;
    lastLoginAt: Date;
    isActive: boolean;
    organizationId: string;
    emailVerifiedAt: Date;
  }>): Promise<UserEntity> {
    const user = await this.prisma.user.update({
      where: { id },
      data:
        data.email !== undefined
          ? { ...data, email: UsersRepository.normalizeEmail(data.email) }
          : data,
      include: this.memberInclude,
    });
    return this.buildEntityFromInclude(user);
  }

  async existsByEmail(email: string, organizationId?: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: {
        ...UsersRepository.emailWhere(email),
        ...(organizationId ? { organizationId } : {}),
      },
    });
    return count > 0;
  }

  async existsByPhone(phone: string, organizationId?: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: {
        ...UsersRepository.phoneWhere(phone),
        ...(organizationId ? { organizationId } : {}),
      },
    });
    return count > 0;
  }

  /**
   * findByOrg — single query with include (no N+1).
   * For 1000 users this was previously 1001 queries; now it is 1 query + 1 join.
   */
  async findByOrg(organizationId: string, skip: number, limit: number): Promise<UserEntity[]> {
    const users = await this.prisma.user.findMany({
      where: { organizationId, isActive: true },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: this.memberInclude,
    });
    return users.map((u) => this.buildEntityFromInclude(u));
  }

  async countByOrg(organizationId: string): Promise<number> {
    return this.prisma.user.count({ where: { organizationId, isActive: true } });
  }

  // ── Pass 14 (FR-DEL-011 / FR-DLC-002/003, LOOP-080, SC-082) ────────────────

  /** Auth-sensitive fields for the account-deletion password check. */
  async findAuthById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        organizationId: true,
        passwordHash: true,
        avatarUrl: true,
        isActive: true,
        name: true,
        email: true,
        phone: true,
      },
    });
  }

  /**
   * Live-Test-5 ISSUE-1 (user decision 2026-07-16: "Full hard purge") — the
   * account-deletion transaction now erases EVERY row belonging to the user:
   * identity, sessions, memberships, attendance (+preference selections via
   * FK cascade), billing ledger, hosted-guest bookings, vacation/correction
   * requests, notice receipts, OTPs (by userId AND identifier), their own
   * events (event-admin), and their audit-log entries. Email and mobile are
   * reusable for a fresh signup the moment this commits (UNI-001/UNI-002).
   *
   * Ordering note: explicit deleteMany calls run before the final user.delete
   * so the transaction never relies on FK cascade side effects for tables
   * that only soft-reference the user (no FK: billing ledger, guests, audit).
   * Group ownership is detached (adminId → null), never deleted — a group
   * with remaining members is the group's data, not the leaver's.
   */
  async hardDeleteAccount(
    userId: string,
    identity: { email?: string | null; phone?: string | null },
  ): Promise<void> {
    const identifiers = [identity.email, identity.phone].filter(
      (v): v is string => !!v,
    );
    await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({ where: { userId } }),
      this.prisma.otpRequest.deleteMany({
        where: {
          OR: [
            { userId },
            ...(identifiers.length > 0
              ? [{ identifier: { in: identifiers } }]
              : []),
          ],
        },
      }),
      this.prisma.attendanceCorrectionRequest.deleteMany({
        where: { userId },
      }),
      this.prisma.vacationRequest.deleteMany({ where: { userId } }),
      this.prisma.noticeRead.deleteMany({ where: { userId } }),
      this.prisma.mealGuest.deleteMany({ where: { hostUserId: userId } }),
      this.prisma.billingLedgerEntry.deleteMany({ where: { userId } }),
      // Cascades attendance_preference_selections rows via FK.
      this.prisma.attendanceRecord.deleteMany({ where: { userId } }),
      // Overrides the user performed on OTHERS' records: keep the record
      // (it is the other member's data), drop the dangling reference.
      this.prisma.attendanceRecord.updateMany({
        where: { markedBy: userId },
        data: { markedBy: null },
      }),
      // Event-admin accounts: their events (and cascaded meal types, guest
      // parties, persons) die with the account.
      this.prisma.event.deleteMany({ where: { adminId: userId } }),
      this.prisma.groupMember.deleteMany({ where: { userId } }),
      (this.prisma as any).group.updateMany({
        where: { adminId: userId },
        data: { adminId: null },
      }),
      // Full audit erasure per the hard-purge decision (actor AND target).
      this.prisma.auditLog.deleteMany({
        where: { OR: [{ actorId: userId }, { targetId: userId }] },
      }),
      this.prisma.user.delete({ where: { id: userId } }),
    ]);
  }

  /**
   * The full account-deletion transaction — revoke, soft-remove, anonymize.
   * The user ROW is retained so attendance/billing/audit foreign keys stay
   * intact (financial integrity, LOOP-080); only PII is erased in place.
   */
  async deleteAccount(userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      // 1. Revoke every session on every device (all token families).
      this.prisma.refreshToken.updateMany({
        where: { userId, isRevoked: false },
        data: { isRevoked: true },
      }),
      // 2. Soft-remove all group memberships (rows retained for history).
      this.prisma.groupMember.updateMany({
        where: { userId, status: 'active' },
        data: { status: 'removed', removedAt: now, removedBy: userId },
      }),
      // 3. Anonymize PII in place. Email stays unique per org via a
      //    deterministic placeholder; phone null clears the unique slot.
      this.prisma.user.update({
        where: { id: userId },
        data: {
          name: 'Deleted User',
          email: `deleted-${userId}@anonymized.invalid`,
          phone: null,
          avatarUrl: null,
          fcmToken: null,
          passwordHash: null,
          gender: null,
          age: null,
          isActive: false,
          deletedAt: now,
        } as any,
      }),
    ]);
  }

  /**
   * REQ (delete → smooth re-create): when the LAST active member of an
   * organization deletes their account, the org's name/slug would otherwise
   * stay locked forever and block the founder from ever re-registering the
   * same organization name (409 slug conflict on admin signup). Archive-rename
   * the now-empty org so the name becomes available again. Groups, billing
   * and audit history are untouched — only the org's display name and slug
   * change. Best-effort: account deletion must never fail because of this.
   */
  async archiveOrganizationIfEmpty(organizationId: string): Promise<void> {
    try {
      const remaining = await this.prisma.user.count({
        where: { organizationId, isActive: true },
      });
      if (remaining > 0) return;
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, slug: true },
      });
      if (!org || org.slug.includes('-archived-')) return;
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: {
          name: `${org.name} (archived)`,
          slug: `${org.slug}-archived-${Date.now()}`,
        },
      });
    } catch {
      /* best-effort — never blocks the deletion that triggered it */
    }
  }
}
