import {
  Injectable,
  Logger,
  Inject,
  Optional,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { MembersRepository } from '../groups/repositories/members.repository';
import { AttendanceService } from '../attendance/attendance.service';
import { AttendanceRepository } from '../attendance/repositories/attendance.repository';
import {
  toUtcMidnight,
  getCurrentTimeInTimezone,
  isWithinWindow,
} from '../../common/utils/date.utils';
import { NotificationsService } from '../notifications/notifications.service';
import { NoticesService } from '../notices/notices.service';
import { PreferencesService } from '../preferences/preferences.service';
import { CorrectionRequestsRepository } from './repositories/correction-requests.repository';
import { CorrectionRequestSerializer } from './serializers/correction-request.serializer';
import { CorrectionRequestEntity } from './entities/correction-request.entity';
import { CreateCorrectionRequestDto } from './dto/create-correction-request.dto';
import { QueryCorrectionRequestDto } from './dto/query-correction-request.dto';
import { ReviewCorrectionRequestDto } from './dto/review-correction-request.dto';

/**
 * requestType → the attendance status it targets (null = no status change).
 * SRS Module 03 COR-004: Present or Absent only — Skip is never a correction
 * target (correct_to_skip REMOVED).
 */
const TYPE_TO_STATUS: Record<string, string | null> = {
  claim_present: 'present',
  correct_to_absent: 'absent',
  fix_preference: null,
  dispute_charge: null,
};

/** Liability-decreasing types — auto-approvable only when configured ON. */
const DECREASE_TYPES = new Set(['correct_to_absent']);

/** Status-changing types — window/same-day guards apply to these. */
const STATUS_CHANGE_TYPES = new Set(['claim_present', 'correct_to_absent']);

/** requestType → human label for admin push notifications (FR-NOTX-017 safe). */
const TYPE_LABELS: Record<string, string> = {
  claim_present: 'Mark me Present',
  correct_to_absent: 'Correct to Absent',
  fix_preference: 'Fix meal preference',
  dispute_charge: 'Dispute a charge',
};

/** Get today's date as YYYY-MM-DD in the given IANA timezone. */
function getTodayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * CorrectionsService — Module 33 Attendance Correction Requests (FR-ACR-*).
 *
 * The member-initiated consent path: after a window closes, a member may
 * request Present (claim), correct a wrong record, fix a preference, or
 * dispute a charge. Liability-increasing requests (claim_present) require
 * admin approval; decreasing corrections auto-approve (configurable);
 * neutral preference fixes auto-apply. Admin-proposed increases arrive as
 * sourceChannel='admin_prompt' confirmations that only the member may
 * confirm/decline (FR-OVR-020).
 *
 * All writes go through AttendanceService.applyConsentedChange so cache
 * invalidation, realtime, price snapshots and audit behave exactly like every
 * other attendance write. organizationId is ALWAYS from the JWT.
 */
@Injectable()
export class CorrectionsService {
  private readonly logger = new Logger(CorrectionsService.name);

  constructor(
    private readonly repo: CorrectionRequestsRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly membersRepo: MembersRepository,
    private readonly attendanceService: AttendanceService,
    private readonly attendanceRepo: AttendanceRepository,
    private readonly notifications: NotificationsService,
    // SRS Module 03 ATT-004/COR-006: full preference validation on submission.
    private readonly preferencesService: PreferencesService,
    // #4: in-app admin bell alert (in addition to push). Optional so tests run
    // without the notices infrastructure wired.
    @Optional() @Inject(NoticesService)
    private readonly notices: NoticesService | null = null,
    @Optional() @Inject('ATTENDANCE_GATEWAY')
    private readonly gateway: {
      emitToGroup(groupId: string, event: string, payload: unknown): void;
      emitToUser(userId: string, event: string, payload: unknown): void;
    } | null,
  ) {}

  private isAdmin(role: string): boolean {
    return (ADMIN_ROLES as readonly string[]).includes(role);
  }

  private cfg<T>(key: string, fallback: T): T {
    return this.config.get<T>(`corrections.${key}`) ?? fallback;
  }

  // ── CREATE (member, FR-ACR-001) ────────────────────────────────────────────

  async createRequest(
    userId: string,
    organizationId: string,
    dto: CreateCorrectionRequestDto,
    requestId?: string,
  ) {
    // Meal + org isolation + timezone + pricing context.
    const meal = await this.prisma.meal.findFirst({
      where: { id: dto.mealId, organizationId },
      select: {
        id: true,
        groupId: true,
        price: true,
        attendanceWindowOpen: true,
        attendanceWindowClose: true,
        organization: { select: { timezone: true } },
        // Live-Test-8 ISSUE-004: planner flags gate the day-override below —
        // rides the same query, no extra round-trip.
        group: {
          select: { weeklyMenuEnabled: true, dayWiseMealsEnabled: true },
        },
      },
    });
    if (!meal) throw new NotFoundException('Meal not found');

    // Member must be active in the meal's group (FR-ACR-001 preconditions).
    //
    // Live-Test-14 ISSUE-001: the requester's CURRENT role rides this same wave
    // (never the possibly-stale JWT claim — same discipline as RolesGuard). It
    // decides admin self-service below, and its `isVacationMode` also serves
    // the claim_present vacation gate further down, so this Promise.all REPLACES
    // that later lookup: no net query is added to the request path.
    const [isMember, requester] = await Promise.all([
      this.membersRepo.isActiveMember(meal.groupId, userId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, isVacationMode: true },
      }),
    ]);
    if (!isMember) {
      throw new ForbiddenException('You are not an active member of this group');
    }

    // ISSUE-001 (user-confirmed rule): an ADMIN / MANAGER correcting their OWN
    // record needs no approval — "admin no need to any approval". They are the
    // approving authority, and FR-ACR-010 already forbids self-approval, so
    // without this an admin's own claim_present could NEVER be actioned (it sat
    // pending until it expired). Self-service applies the change immediately.
    //
    // Nothing else is relaxed: they must still be an active member of THIS
    // group, the date must still be today (COR-005), the window must still have
    // closed, preference selections are still fully validated, and a
    // vacationing admin still cannot claim Present. Org isolation is unchanged
    // (the meal was resolved org-scoped from the JWT).
    const selfService = this.isAdmin(requester?.role ?? '');

    const orgTz = meal.organization?.timezone ?? 'Asia/Kolkata';
    const todayStr = getTodayInTimezone(orgTz);
    const dateStr = dto.attendanceDate.slice(0, 10);

    // No future dates.
    if (dateStr > todayStr) {
      throw new BadRequestException({
        message: 'Corrections cannot be requested for future dates',
        errors: { attendanceDate: 'Must be today or a past date' },
      });
    }

    // SRS Module 03 COR-005: corrections are SAME CALENDAR DAY ONLY (until
    // 11:59:59 PM IST). The limit is fixed and deliberately NOT configurable —
    // historical attendance records cannot be corrected.
    if (dateStr !== todayStr) {
      throw new BadRequestException({
        message:
          'Correction period has expired. Attendance corrections are allowed only until 11:59:59 PM IST on the same calendar day.',
        errors: {
          attendanceDate: 'Historical attendance records cannot be corrected',
        },
      });
    }

    // fix_preference requires the new preference value.
    if (dto.requestType === 'fix_preference' && !dto.requestedPreference) {
      throw new BadRequestException({
        message: 'requestedPreference is required for fix_preference',
        errors: { requestedPreference: 'Provide the corrected preference' },
      });
    }

    // COR-005 eligibility: the attendance window must have already CLOSED —
    // while it is open, status changes go through normal marking. Applies to
    // every status-changing type (claim_present AND correct_to_absent).
    // Live-Test-8 ISSUE-004: the resolved day view is KEPT — the preference
    // validation below applies the same published-day override as marking.
    let dayEffective: Awaited<
      ReturnType<AttendanceService['resolveEffectiveWindow']>
    > | null = null;
    if (STATUS_CHANGE_TYPES.has(dto.requestType) && dateStr === todayStr) {
      const effective = await this.attendanceService.resolveEffectiveWindow(
        meal.id,
        meal.groupId,
        organizationId,
        dateStr,
        {
          openTime: meal.attendanceWindowOpen,
          closeTime: meal.attendanceWindowClose,
          price: meal.price ?? null,
        },
      );
      dayEffective = effective;
      if (
        effective.openTime &&
        effective.closeTime &&
        isWithinWindow(
          getCurrentTimeInTimezone(orgTz),
          effective.openTime,
          effective.closeTime,
        )
      ) {
        throw new BadRequestException({
          message:
            'The attendance window is still open — mark your attendance normally instead',
          errors: { requestType: 'Window open; no correction needed' },
        });
      }
    }

    // Vacation members cannot claim Present (FR-ACR-001 preconditions).
    // ISSUE-001: served by the `requester` row already fetched above — the
    // dedicated lookup that used to live here was removed, not duplicated.
    if (dto.requestType === 'claim_present' && requester?.isVacationMode) {
      throw new BadRequestException({
        message: 'You are on vacation mode — corrections to Present are unavailable',
        errors: { requestType: 'Disable vacation mode first' },
      });
    }

    // SRS Module 03 ATT-004/COR-006: when the correction targets Present on a
    // meal with preference groups, the member must complete the ENTIRE
    // preference selection again — validated with exactly the same rules as
    // normal attendance marking. The validated set is stored on the request
    // and applied verbatim on approval (the admin never edits it).
    if (dto.requestType === 'claim_present') {
      let pgGroups = await this.preferencesService.getEffectiveGroupsForMeal(
        meal.id,
        organizationId,
      );
      // Live-Test-8 ISSUE-004: corrections follow the SAME single source of
      // truth as marking — the published day entry narrows/disables the
      // required groups (applyDayOverride), so a claim_present never demands
      // master groups the member was never shown that day. Same gate as
      // markAttendance: planner ON + an entry published for the date.
      const plannerActive =
        (meal as any).group?.weeklyMenuEnabled === true ||
        (meal as any).group?.dayWiseMealsEnabled === true;
      if (
        pgGroups.length > 0 &&
        plannerActive &&
        dayEffective?.scheduledToday
      ) {
        pgGroups = this.preferencesService.applyDayOverride(
          pgGroups,
          dayEffective,
        );
      }
      if (pgGroups.length > 0) {
        // Throws 422 with per-group errors when mandatory selections are
        // missing/invalid — mirrors markAttendance (FR-PG-031/032).
        this.preferencesService.validateSelections(
          pgGroups,
          dto.selections ?? [],
        );
      }
    }

    const attendanceDate = toUtcMidnight(dateStr);

    // One open request per (member, meal, date) — FR-ACR-020.
    if (
      await this.repo.findOpenDuplicate(
        organizationId,
        userId,
        dto.mealId,
        attendanceDate,
      )
    ) {
      throw new BadRequestException({
        message: 'You already have a pending request for this meal and date',
        errors: { mealId: 'Duplicate open request' },
      });
    }

    // Rate limits — FR-ACR-020.
    const maxOpen = this.cfg('maxOpenPerMember', 3);
    if ((await this.repo.countOpenForUser(organizationId, userId)) >= maxOpen) {
      throw new BadRequestException({
        message: `You already have ${maxOpen} open requests — wait for a decision first`,
        errors: { requestType: 'Too many open requests' },
      });
    }
    const maxPerDay = this.cfg('maxPerDay', 5);
    const createdToday = await this.repo.countCreatedSince(
      organizationId,
      userId,
      toUtcMidnight(todayStr),
    );
    if (createdToday >= maxPerDay) {
      throw new BadRequestException({
        message: `Daily correction-request limit (${maxPerDay}) reached — try again tomorrow`,
        errors: { requestType: 'Daily limit reached' },
      });
    }

    const expiryHours = this.cfg('expiryHours', 48);
    const created = await this.repo.create({
      organizationId,
      groupId: meal.groupId,
      userId,
      mealId: dto.mealId,
      attendanceDate,
      requestType: dto.requestType,
      requestedStatus: TYPE_TO_STATUS[dto.requestType] ?? null,
      requestedPreference: dto.requestedPreference ?? null,
      // ATT-004/COR-006: member-submitted selection set (applied on approval).
      requestedSelections: dto.selections ?? null,
      reason: dto.reason ?? null,
      evidenceUrl: dto.evidenceUrl ?? null,
      sourceChannel: 'member',
      expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
    });

    this.audit.log({
      organizationId,
      actorId: userId,
      targetId: created.id,
      targetType: 'AttendanceCorrectionRequest',
      action: 'create',
      metadata: { requestType: dto.requestType, mealId: dto.mealId, dateStr },
      requestId,
    });

    // Admin queue refresh (group room) — "Riya requests Present for Lunch".
    this.gateway?.emitToGroup(
      meal.groupId,
      'correction.requested.v1',
      CorrectionRequestSerializer.toResponse(created),
    );

    // Auto-processing (FR-ACR-001 business rules):
    //  • liability-DECREASING corrections auto-approve when configured;
    //  • neutral preference fixes auto-apply when a record exists.
    if (DECREASE_TYPES.has(dto.requestType) && this.cfg('absentAutoApprove', true)) {
      return this.applyDecision(created, {
        decidedBy: userId, // member-initiated, system-applied
        note: 'Auto-approved — this correction does not increase your bill',
        auto: true,
        requestId,
      });
    }
    if (dto.requestType === 'fix_preference') {
      const existing = await this.attendanceRepo.findByKey(
        userId,
        dto.mealId,
        attendanceDate,
        organizationId,
      );
      if (existing) {
        return this.applyDecision(created, {
          decidedBy: userId,
          note: 'Auto-applied — preference changes are billing-neutral',
          auto: true,
          existingStatus: existing.status,
          requestId,
        });
      }
    }

    // ISSUE-001: admin / manager self-service. Everything that is a genuine
    // ATTENDANCE correction applies at once — in practice this is claim_present
    // (the liability-increasing type that normally waits for another admin);
    // correct_to_absent and fix_preference already auto-resolved above for
    // everyone. `dispute_charge` is deliberately EXCLUDED: a charge dispute is a
    // money conversation resolved through the append-only ledger, not something
    // an admin silently self-approves.
    if (selfService && STATUS_CHANGE_TYPES.has(dto.requestType)) {
      return this.applyDecision(created, {
        decidedBy: userId,
        note: 'Auto-applied — admin self-service correction (same day)',
        auto: true,
        requestId,
      });
    }

    // Still pending → an admin review is genuinely waiting. Best-effort push
    // to group admins (FR-ACR / ISSUE-15); auto-approved paths returned above.
    void this.notifications.notifyCorrectionRequested({
      organizationId,
      requesterName: created.userName ?? 'A member',
      typeLabel: TYPE_LABELS[dto.requestType] ?? dto.requestType,
      mealName: created.mealName ?? 'a meal',
      dateStr,
    });

    // #4: in-app admin bell alert (admins-only audience) so the request is
    // visible even without a push token. Best-effort — never blocks the write.
    if (this.notices) {
      const typeLabel = TYPE_LABELS[dto.requestType] ?? dto.requestType;
      void this.notices.createRequestAlert({
        organizationId,
        groupId: created.groupId ?? null,
        actorId: userId,
        title: 'New correction request',
        body: `${created.userName ?? 'A member'} requested "${typeLabel}" for ${
          created.mealName ?? 'a meal'
        } on ${dateStr}. Tap to review.`,
        priority: 'high',
        linkType: 'correctionRequests', // deep-link → admin Correction Requests queue
      });
    }

    return CorrectionRequestSerializer.toResponse(created);
  }

  // ── LIST (member: own · admin: group queue) ────────────────────────────────

  async listRequests(
    userId: string,
    role: string,
    organizationId: string,
    query: QueryCorrectionRequestDto,
  ) {
    // FR-ACR-011 lazy expiry sweep — one cheap indexed updateMany per list.
    await this.repo.expireDue(organizationId);

    const admin = this.isAdmin(role);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const { data, total } = await this.repo.list(organizationId, {
      // Members may only ever see their OWN requests.
      userId: admin ? undefined : userId,
      groupId: query.groupId,
      status: query.status,
      sourceChannel: query.sourceChannel,
      page,
      limit,
    });
    return {
      data: CorrectionRequestSerializer.toList(data),
      total,
      page,
      limit,
    };
  }

  // ── REVIEW (admin approve/reject — FR-ACR-010) ─────────────────────────────

  async approve(
    adminId: string,
    organizationId: string,
    id: string,
    dto: ReviewCorrectionRequestDto,
    requestId?: string,
  ) {
    const existing = await this.loadPending(id, organizationId);
    if (existing.sourceChannel !== 'member') {
      throw new BadRequestException({
        message:
          'This is a member confirmation — only the member can confirm or decline it',
        errors: { id: 'Not admin-reviewable' },
      });
    }
    // No self-approval (FR-ACR-010 permissions).
    if (existing.userId === adminId) {
      throw new ForbiddenException('You cannot approve your own request');
    }
    // Member must still be active (FR-ACR-010 exception path).
    const stillMember = await this.membersRepo.isActiveMember(
      existing.groupId,
      existing.userId,
    );
    if (!stillMember) {
      throw new BadRequestException({
        message: 'The member is no longer active in this group',
        errors: { userId: 'Member removed or blocked' },
      });
    }

    return this.applyDecision(existing, {
      decidedBy: adminId,
      note: dto.note ?? null,
      auto: false,
      requestId,
    });
  }

  async reject(
    adminId: string,
    organizationId: string,
    id: string,
    dto: ReviewCorrectionRequestDto,
    requestId?: string,
  ) {
    const existing = await this.loadPending(id, organizationId);
    if (existing.sourceChannel !== 'member') {
      throw new BadRequestException({
        message:
          'This is a member confirmation — only the member can confirm or decline it',
        errors: { id: 'Not admin-reviewable' },
      });
    }
    const updated = await this.repo.updateStatus(id, organizationId, {
      status: 'rejected',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNote: dto.note ?? null,
    });
    this.auditDecision(organizationId, adminId, id, 'rejected', requestId);
    this.notifyDecision(updated);
    return CorrectionRequestSerializer.toResponse(updated);
  }

  // ── MEMBER actions (cancel / confirm / decline) ────────────────────────────

  /** Member cancels their own pending request (FR-ACR-011). */
  async cancel(
    userId: string,
    organizationId: string,
    id: string,
    dto: ReviewCorrectionRequestDto,
    requestId?: string,
  ) {
    const existing = await this.loadPending(id, organizationId);
    if (existing.userId !== userId) {
      throw new ForbiddenException('You can only cancel your own request');
    }
    const updated = await this.repo.updateStatus(id, organizationId, {
      status: 'cancelled',
      reviewedAt: new Date(),
      reviewNote: dto.note ?? existing.reviewNote,
    });
    this.auditDecision(organizationId, userId, id, 'cancelled', requestId);
    return CorrectionRequestSerializer.toResponse(updated);
  }

  // SRS Module 03 ATT-004: the FR-OVR-020 confirm/decline flow (admin-proposed
  // increases awaiting member consent) was REMOVED together with the admin
  // override — corrections are member-initiated only.

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Load + 404 + lazy-expire guard: expired pendings become non-actionable. */
  private async loadPending(
    id: string,
    organizationId: string,
  ): Promise<CorrectionRequestEntity> {
    const existing = await this.repo.findById(id, organizationId);
    if (!existing) {
      throw new NotFoundException({
        message: 'Correction request not found',
        errors: { id: 'Does not exist in your organization' },
      });
    }
    if (
      existing.status === 'pending' &&
      existing.expiresAt.getTime() < Date.now()
    ) {
      await this.repo.updateStatus(id, organizationId, { status: 'expired' });
      throw new BadRequestException({
        message: 'This request has expired and can no longer be actioned',
        errors: { status: 'expired' },
      });
    }
    if (existing.status !== 'pending') {
      throw new BadRequestException({
        message: 'Only pending requests can be actioned',
        errors: { status: `Request is already ${existing.status}` },
      });
    }
    return existing;
  }

  /**
   * Apply an approval: write the attendance change through the shared
   * consented-change path, then close the request. Idempotent at the record
   * level (attendance upsert) and guarded at the request level (pending-only).
   */
  private async applyDecision(
    request: CorrectionRequestEntity,
    opts: {
      decidedBy: string;
      note: string | null;
      auto: boolean;
      markedBy?: string | null;
      existingStatus?: string;
      requestId?: string;
    },
  ) {
    const dateStr = request.attendanceDate.toISOString().slice(0, 10);

    let resultRecordId: string | null = null;
    if (request.requestType === 'dispute_charge') {
      // Dispute approval acknowledges the dispute; monetary resolution is
      // append-only ledger work (Module 25) — no attendance change here.
    } else if (request.requestType === 'fix_preference') {
      // Neutral: keep the existing status, change only the preference.
      const status =
        opts.existingStatus ??
        (
          await this.attendanceRepo.findByKey(
            request.userId,
            request.mealId,
            request.attendanceDate,
            request.organizationId,
          )
        )?.status;
      if (!status) {
        throw new BadRequestException({
          message: 'No attendance record exists to fix the preference on',
          errors: { requestType: 'Nothing to fix' },
        });
      }
      const record = await this.attendanceService.applyConsentedChange({
        actorId: opts.decidedBy,
        organizationId: request.organizationId,
        userId: request.userId,
        groupId: request.groupId,
        mealId: request.mealId,
        attendanceDate: dateStr,
        status,
        preference: request.requestedPreference,
        markedBy: opts.markedBy ?? (opts.auto ? null : opts.decidedBy),
        source: 'request',
        sourceRequestId: request.id,
        auditMetadata: { requestType: request.requestType, auto: opts.auto },
        requestId: opts.requestId,
      });
      resultRecordId = record.id;
    } else {
      const record = await this.attendanceService.applyConsentedChange({
        actorId: opts.decidedBy,
        organizationId: request.organizationId,
        userId: request.userId,
        groupId: request.groupId,
        mealId: request.mealId,
        attendanceDate: dateStr,
        status: request.requestedStatus ?? 'present',
        preference: request.requestedPreference,
        // ATT-004/COR-006: the member's submitted selection set is applied
        // verbatim — the admin only approved, never edited it.
        selections:
          (request.requestedSelections as Array<Record<string, unknown>>) ??
          null,
        markedBy: opts.markedBy ?? (opts.auto ? null : opts.decidedBy),
        source: 'request',
        sourceRequestId: request.id,
        auditMetadata: { requestType: request.requestType, auto: opts.auto },
        requestId: opts.requestId,
      });
      resultRecordId = record.id;
    }

    const updated = await this.repo.updateStatus(
      request.id,
      request.organizationId,
      {
        status: 'approved',
        // For admin_prompt confirmations reviewedBy stays the proposing admin.
        reviewedBy:
          request.sourceChannel === 'admin_prompt'
            ? request.reviewedBy
            : opts.auto
              ? null
              : opts.decidedBy,
        reviewedAt: new Date(),
        reviewNote: opts.note,
        resultRecordId,
      },
    );

    this.auditDecision(
      request.organizationId,
      opts.decidedBy,
      request.id,
      opts.auto ? 'auto-approved' : 'approved',
      opts.requestId,
    );
    this.notifyDecision(updated);
    return CorrectionRequestSerializer.toResponse(updated);
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
      targetType: 'AttendanceCorrectionRequest',
      action: 'update',
      metadata: { decision },
      requestId,
    });
  }

  /** Member + group get the decision in real time (FR-ACR notifications). */
  private notifyDecision(request: CorrectionRequestEntity): void {
    const payload = CorrectionRequestSerializer.toResponse(request);
    this.gateway?.emitToUser(request.userId, 'correction.decided.v1', payload);
    this.gateway?.emitToGroup(request.groupId, 'correction.decided.v1', payload);
    // Best-effort push so the member hears the decision even with the app
    // closed (FR-ACR notifications; never throws — FR-NOTX-016).
    void this.notifications.notifyCorrectionDecided({
      organizationId: request.organizationId,
      userId: request.userId,
      approved: request.status === 'approved',
      mealName: request.mealName ?? 'your meal',
      dateStr: request.attendanceDate.toISOString().slice(0, 10),
    });
    // command_3: targeted in-app notice into the member's bell (Notification
    // Center), deep-linked to My Corrections. Best-effort — never throws.
    if (this.notices) {
      const approved = request.status === 'approved';
      void this.notices.createMemberAlert({
        organizationId: request.organizationId,
        groupId: request.groupId,
        actorId: request.userId,
        targetUserId: request.userId,
        title: approved ? 'Correction approved' : 'Correction rejected',
        body: approved
          ? `Your attendance correction for ${request.mealName ?? 'a meal'} was approved.`
          : `Your attendance correction for ${request.mealName ?? 'a meal'} was rejected.`,
        linkType: 'myCorrections',
      });
    }
  }
}
