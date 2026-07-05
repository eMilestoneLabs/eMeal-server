import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { VacationRequestsRepository } from './repositories/vacation-requests.repository';
import { VacationRequestSerializer } from './serializers/vacation-request.serializer';
import { AuditService } from '../../audit/audit.service';
import { QueueService } from '../../queue/queue.service';
import { NoticesService } from '../notices/notices.service';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import {
  getTodayInTimezone,
  toUtcMidnight,
} from '../../common/utils/date.utils';
import { CreateVacationRequestDto } from './dto/create-vacation-request.dto';
import { QueryVacationRequestDto } from './dto/query-vacation-request.dto';
import { ReviewVacationRequestDto } from './dto/review-vacation-request.dto';

function parseDate(value: string): Date {
  // Accept YYYY-MM-DD (UTC midnight) or full ISO-8601.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  return new Date(value);
}

/**
 * VacationsService — Issue 3 vacation approval workflow.
 *
 * Controllers stay thin; tenant isolation + business rules live here.
 * organizationId is ALWAYS from the JWT. Approving a request additively flips
 * the member's existing isVacationMode flag ON; cancelling an approved request
 * flips it OFF — so the workflow integrates with the existing self-service
 * vacation mechanism without replacing it.
 */
@Injectable()
export class VacationsService {
  private readonly logger = new Logger(VacationsService.name);

  constructor(
    private readonly repo: VacationRequestsRepository,
    private readonly audit: AuditService,
    // Fire-and-forget member notifications (FR-VACX-007) — optional so the
    // module works (and tests run) without queue infrastructure. Explicit
    // @Inject: `Class | null` erases design:paramtypes (Pass 7 gotcha).
    @Optional()
    @Inject(QueueService)
    private readonly queue: QueueService | null = null,
    // #4: in-app admin bell alert on request submission. Optional so the module
    // (and its tests) run without the notices infrastructure wired.
    @Optional()
    @Inject(NoticesService)
    private readonly notices: NoticesService | null = null,
  ) {}

  private isAdmin(role: string): boolean {
    return (ADMIN_ROLES as readonly string[]).includes(role);
  }

  /** Today (UTC-midnight Date) in the org's timezone — FR-VACX-006. */
  private async orgToday(organizationId: string): Promise<Date> {
    const tz = await this.repo.getOrgTimezone(organizationId);
    return toUtcMidnight(getTodayInTimezone(tz));
  }

  /** Fire-and-forget push to the affected member — never blocks the response. */
  private notifyMember(
    organizationId: string,
    userId: string,
    title: string,
    body: string,
  ): void {
    // command_3: also drop a targeted in-app notice into the member's bell so
    // the approval/rejection is visible without a push token, deep-linked to
    // their vacation screen. Best-effort — createMemberAlert never throws.
    if (this.notices) {
      void this.notices.createMemberAlert({
        organizationId,
        actorId: userId,
        targetUserId: userId,
        title,
        body,
        linkType: 'myVacations',
      });
    }
    if (!this.queue) return;
    void this.repo
      .getUserPush(userId)
      .then((r) =>
        r
          ? this.queue!.enqueueBatchPush({
              organizationId,
              recipients: [r],
              title,
              body,
              // Registered frontend path (Issue 6: roleless routes 404'd in-app).
              route: '/student/settings',
              data: { type: 'vacation_update' },
            })
          : undefined,
      )
      .catch((err) =>
        this.logger.warn(`vacation push failed: ${(err as Error).message}`),
      );
  }

  async createRequest(
    userId: string,
    organizationId: string,
    dto: CreateVacationRequestDto,
    requestId?: string,
  ) {
    const startDate = parseDate(dto.startDate);
    const endDate = parseDate(dto.endDate);
    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException({
        message: 'Invalid vacation range',
        errors: { endDate: 'endDate must be on or after startDate' },
      });
    }

    // FR-VACX-002 (LOOP-040): vacation is FORWARD-ONLY — it can never cover
    // already-consumed or finalized days, so back-dating cannot erase bills.
    // "Today" is the org business day, not UTC (FR-VACX-006).
    const todayUtc = await this.orgToday(organizationId);
    if (startDate.getTime() < todayUtc.getTime()) {
      throw new UnprocessableEntityException({
        message: 'Vacation cannot start in the past',
        code: 'VACATION_PAST_DATES',
        errors: {
          startDate: `Vacation is forward-only — earliest start is today (${todayUtc
            .toISOString()
            .slice(0, 10)})`,
        },
      });
    }
    const RANGE_CAP_DAYS = 365;
    const rangeDays =
      (endDate.getTime() - startDate.getTime()) / 86_400_000 + 1;
    if (rangeDays > RANGE_CAP_DAYS) {
      throw new UnprocessableEntityException({
        message: 'Vacation range too large',
        code: 'VACATION_RANGE_TOO_LARGE',
        errors: { endDate: `Maximum ${RANGE_CAP_DAYS} days per request` },
      });
    }

    // FR-VACX-001: reject-on-overlap policy — one request governs a date.
    const overlap = await this.repo.findOverlapping(
      userId,
      organizationId,
      dto.groupId ?? null,
      startDate,
      endDate,
    );
    if (overlap) {
      throw new UnprocessableEntityException({
        message: 'An overlapping vacation request already exists',
        code: 'VACATION_OVERLAP',
        errors: {
          startDate: `Overlaps your ${overlap.status} request ${overlap.startDate
            .toISOString()
            .slice(0, 10)} – ${overlap.endDate.toISOString().slice(0, 10)}`,
        },
      });
    }

    const userName = await this.repo.getUserName(userId);
    const created = await this.repo.create({
      organizationId,
      groupId: dto.groupId ?? null,
      userId,
      userName,
      startDate,
      endDate,
      // FR-VACX-003: meal-granular boundaries (lowercase slot keys).
      startSlotKey: dto.startSlotKey?.trim().toLowerCase() || null,
      endSlotKey: dto.endSlotKey?.trim().toLowerCase() || null,
      reason: dto.reason ?? null,
    });

    this.audit.log({
      organizationId,
      actorId: userId,
      targetId: created.id,
      targetType: 'VacationRequest',
      action: 'create',
      metadata: {
        startDate: dto.startDate,
        endDate: dto.endDate,
        ...(dto.startSlotKey ? { startSlotKey: dto.startSlotKey } : {}),
        ...(dto.endSlotKey ? { endSlotKey: dto.endSlotKey } : {}),
      },
      requestId,
    });

    // #4: surface the new request in the admin bell (in-app notice, admins-only
    // audience) so admins are alerted even without a push token. Best-effort —
    // never blocks or fails the request write.
    if (this.notices) {
      const range =
        dto.startDate === dto.endDate
          ? dto.startDate
          : `${dto.startDate} – ${dto.endDate}`;
      void this.notices.createRequestAlert({
        organizationId,
        groupId: dto.groupId ?? null,
        actorId: userId,
        title: 'New vacation request',
        body: `${userName} requested vacation for ${range}. Tap to review.`,
        priority: 'high',
        linkType: 'vacationRequests', // deep-link → admin Vacation Requests queue
      });
    }

    return VacationRequestSerializer.toResponse(created);
  }

  async listRequests(
    userId: string,
    role: string,
    organizationId: string,
    query: QueryVacationRequestDto,
  ) {
    const admin = this.isAdmin(role);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const { data, total } = await this.repo.list(organizationId, {
      // Members may only ever see their OWN requests.
      userId: admin ? undefined : userId,
      groupId: query.groupId,
      status: query.status,
      page,
      limit,
    });
    return {
      data: VacationRequestSerializer.toList(data),
      total,
      page,
      limit,
    };
  }

  private async loadOr404(id: string, organizationId: string) {
    const existing = await this.repo.findById(id, organizationId);
    if (!existing) {
      throw new NotFoundException({
        message: 'Vacation request not found',
        errors: { id: 'Does not exist in your organization' },
      });
    }
    return existing;
  }

  async approve(
    adminId: string,
    organizationId: string,
    id: string,
    dto: ReviewVacationRequestDto,
    requestId?: string,
  ) {
    const existing = await this.loadOr404(id, organizationId);
    if (existing.status !== 'pending') {
      throw new BadRequestException({
        message: 'Only pending requests can be approved',
        errors: { status: `Request is already ${existing.status}` },
      });
    }
    const updated = await this.repo.updateStatus(id, organizationId, {
      status: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNote: dto.note ?? null,
    });

    // FR-VACX-006: the flag mirrors the approved RANGE, TZ-correct — a
    // future-dated approval does NOT flip vacation on today; the lifecycle
    // sweep (and read-time sync) activates it on the start date in org time.
    const todayUtc = await this.orgToday(organizationId);
    const coversToday =
      existing.startDate.getTime() <= todayUtc.getTime() &&
      existing.endDate.getTime() >= todayUtc.getTime();
    if (coversToday) {
      await this.repo.setUserVacation(existing.userId, organizationId, true);
    }

    // FR-VACX-004 (LOOP-046): overlapping explicit Present marks are KEPT
    // (a member's action is never silently discarded) and the conflict is
    // surfaced to both admin (response) and member (push).
    const conflicts = await this.repo.findPresentConflicts(
      existing.userId,
      organizationId,
      existing.groupId,
      existing.startDate,
      existing.endDate,
    );

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'VacationRequest',
      action: 'update',
      metadata: {
        status: 'approved',
        activatedNow: coversToday,
        ...(conflicts.length > 0 ? { presentConflicts: conflicts.length } : {}),
      },
      requestId,
    });

    this.notifyMember(
      organizationId,
      existing.userId,
      'Vacation approved',
      conflicts.length > 0
        ? `Your vacation was approved. Note: ${conflicts.length} day(s) you already marked Present stay billed as marked.`
        : 'Your vacation request was approved.',
    );

    return {
      ...VacationRequestSerializer.toResponse(updated),
      // Additive: keep-Present conflicts for the admin UI (FR-VACX-004).
      conflicts,
    };
  }

  async reject(
    adminId: string,
    organizationId: string,
    id: string,
    dto: ReviewVacationRequestDto,
    requestId?: string,
  ) {
    const existing = await this.loadOr404(id, organizationId);
    if (existing.status !== 'pending') {
      throw new BadRequestException({
        message: 'Only pending requests can be rejected',
        errors: { status: `Request is already ${existing.status}` },
      });
    }
    const updated = await this.repo.updateStatus(id, organizationId, {
      status: 'rejected',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNote: dto.note ?? null,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'VacationRequest',
      action: 'update',
      metadata: { status: 'rejected' },
      requestId,
    });

    this.notifyMember(
      organizationId,
      existing.userId,
      'Vacation request rejected',
      dto.note
        ? `Your vacation request was rejected: ${dto.note}`
        : 'Your vacation request was rejected by your admin.',
    );

    return VacationRequestSerializer.toResponse(updated);
  }

  async cancel(
    userId: string,
    role: string,
    organizationId: string,
    id: string,
    dto: ReviewVacationRequestDto,
    requestId?: string,
  ) {
    const existing = await this.loadOr404(id, organizationId);
    const admin = this.isAdmin(role);
    // Owner may cancel their own request; admins may cancel any.
    if (!admin && existing.userId !== userId) {
      throw new ForbiddenException({
        message: 'You can only cancel your own vacation request',
        errors: { id: 'Not the owner' },
      });
    }
    if (existing.status === 'cancelled' || existing.status === 'rejected') {
      throw new BadRequestException({
        message: 'Request cannot be cancelled',
        errors: { status: `Request is already ${existing.status}` },
      });
    }
    const wasApproved = existing.status === 'approved';
    const updated = await this.repo.updateStatus(id, organizationId, {
      status: 'cancelled',
      reviewedBy: admin ? userId : existing.reviewedBy,
      reviewedAt: new Date(),
      reviewNote: dto.note ?? existing.reviewNote,
    });
    // If an approved vacation is cancelled, resync the flag: OFF unless some
    // OTHER approved request still covers today in org time (FR-VACX-006).
    if (wasApproved) {
      const todayUtc = await this.orgToday(organizationId);
      const stillCovered = await this.repo.hasApprovedCovering(
        existing.userId,
        organizationId,
        todayUtc,
        id,
      );
      if (!stillCovered) {
        await this.repo.setUserVacation(existing.userId, organizationId, false);
      }
    }

    this.audit.log({
      organizationId,
      actorId: userId,
      targetId: id,
      targetType: 'VacationRequest',
      action: 'update',
      metadata: { status: 'cancelled' },
      requestId,
    });

    return VacationRequestSerializer.toResponse(updated);
  }
}
