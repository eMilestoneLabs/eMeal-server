import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { VacationRequestsRepository } from './repositories/vacation-requests.repository';
import { VacationRequestSerializer } from './serializers/vacation-request.serializer';
import { AuditService } from '../../audit/audit.service';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
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
  ) {}

  private isAdmin(role: string): boolean {
    return (ADMIN_ROLES as readonly string[]).includes(role);
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
    const userName = await this.repo.getUserName(userId);
    const created = await this.repo.create({
      organizationId,
      groupId: dto.groupId ?? null,
      userId,
      userName,
      startDate,
      endDate,
      reason: dto.reason ?? null,
    });

    this.audit.log({
      organizationId,
      actorId: userId,
      targetId: created.id,
      targetType: 'VacationRequest',
      action: 'create',
      metadata: { startDate: dto.startDate, endDate: dto.endDate },
      requestId,
    });

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
    // Additive: turn the member's vacation mode ON.
    await this.repo.setUserVacation(existing.userId, organizationId, true);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'VacationRequest',
      action: 'update',
      metadata: { status: 'approved' },
      requestId,
    });

    return VacationRequestSerializer.toResponse(updated);
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
    // If an approved vacation is cancelled, turn the member's flag OFF.
    if (wasApproved) {
      await this.repo.setUserVacation(existing.userId, organizationId, false);
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
