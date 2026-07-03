import {
  Injectable,
  Logger,
  Inject,
  Optional,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { NoticesRepository } from './repositories/notices.repository';
import { NoticeSerializer } from './serializers/notice.serializer';
import { AuditService } from '../../audit/audit.service';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeDto } from './dto/update-notice.dto';
import { QueryNoticeDto } from './dto/query-notice.dto';
import { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeEventsService } from '../../realtime/services/realtime-events.service';

/**
 * NoticesService — Phase B: in-app notice board + bell center (no FCM).
 *
 * Controllers stay thin; all tenant isolation + business rules live here.
 * organizationId is ALWAYS supplied from the JWT (never the client payload).
 */
@Injectable()
export class NoticesService {
  private readonly logger = new Logger(NoticesService.name);

  constructor(
    private readonly repo: NoticesRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Optional()
    @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
  ) {}

  private isAdmin(role: string): boolean {
    return (ADMIN_ROLES as readonly string[]).includes(role);
  }

  // ── CREATE (admin) ─────────────────────────────────────────────────────────

  async createNotice(
    adminId: string,
    organizationId: string,
    dto: CreateNoticeDto,
    requestId?: string,
  ) {
    const notice = await this.repo.create({
      organizationId,
      groupId: dto.groupId ?? null,
      createdBy: adminId,
      title: dto.title,
      body: dto.body,
      priority: dto.priority ?? 'normal',
      pinned: dto.pinned ?? false,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: notice.id,
      targetType: 'Notice',
      action: 'create',
      metadata: { groupId: notice.groupId, priority: notice.priority },
      requestId,
    });

    // Realtime: notify the group (or the whole org for org-wide notices).
    const payload = {
      organizationId,
      groupId: notice.groupId,
      noticeId: notice.id,
      title: notice.title,
      priority: notice.priority,
      pinned: notice.pinned,
      publishedAt: notice.publishedAt.toISOString(),
    };
    this.realtime?.emitNoticeCreated(organizationId, notice.groupId, payload);

    // FR-NOTX-006 / ISSUE-15: best-effort push to in-scope members. The stored
    // notice above is the reliable in-app channel (FR-NOTX-018) — the method
    // never throws, so publishing succeeds even if push fails (FR-NOTX-016).
    void this.notifications.notifyNoticePublished({
      organizationId,
      groupId: notice.groupId,
      noticeId: notice.id,
      title: notice.title,
      priority: notice.priority,
    });

    return NoticeSerializer.toResponse(notice);
  }

  // ── LIST (members + admins) ─────────────────────────────────────────────────

  async listNotices(
    userId: string,
    role: string,
    organizationId: string,
    query: QueryNoticeDto,
  ) {
    const admin = this.isAdmin(role);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Members may only request notices for a group they actively belong to —
    // prevents cross-group leakage inside the same organization.
    if (!admin && query.groupId) {
      const member = await this.repo.isActiveMember(query.groupId, userId);
      if (!member) {
        throw new ForbiddenException({
          message: 'You are not a member of this group',
          errors: { groupId: 'Not an active member' },
        });
      }
    }

    const { data, total } = await this.repo.list(organizationId, userId, {
      groupId: query.groupId,
      includeInactive: admin ? !!query.includeInactive : false,
      page,
      limit,
      withReadCount: admin,
    });

    return {
      data: NoticeSerializer.toList(data),
      total,
      page,
      limit,
    };
  }

  // ── UNREAD COUNT (members + admins) ─────────────────────────────────────────

  async getUnreadCount(
    userId: string,
    role: string,
    organizationId: string,
    groupId?: string,
  ) {
    if (!this.isAdmin(role) && groupId) {
      const member = await this.repo.isActiveMember(groupId, userId);
      if (!member) return { count: 0 };
    }
    const count = await this.repo.unreadCount(organizationId, userId, groupId);
    return { count };
  }

  // ── MARK READ (members + admins) ────────────────────────────────────────────

  async markRead(userId: string, organizationId: string, noticeId: string) {
    const notice = await this.repo.findById(noticeId, organizationId);
    if (!notice) {
      throw new NotFoundException({
        message: 'Notice not found',
        errors: { id: 'Notice does not exist in your organization' },
      });
    }
    await this.repo.markRead(noticeId, userId);
    return { success: true };
  }

  async markAllRead(userId: string, organizationId: string, groupId?: string) {
    const updated = await this.repo.markAllRead(organizationId, userId, groupId);
    return { success: true, updated };
  }

  // ── UPDATE (admin) ───────────────────────────────────────────────────────────

  async updateNotice(
    adminId: string,
    organizationId: string,
    id: string,
    dto: UpdateNoticeDto,
    requestId?: string,
  ) {
    const existing = await this.repo.findById(id, organizationId);
    if (!existing) {
      throw new NotFoundException({
        message: 'Notice not found',
        errors: { id: 'Notice does not exist in your organization' },
      });
    }
    const updated = await this.repo.update(id, organizationId, {
      title: dto.title,
      body: dto.body,
      priority: dto.priority,
      pinned: dto.pinned,
      expiresAt:
        dto.expiresAt === undefined
          ? undefined
          : dto.expiresAt
            ? new Date(dto.expiresAt)
            : null,
      isActive: dto.isActive,
    });

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'Notice',
      action: 'update',
      requestId,
    });

    return NoticeSerializer.toResponse(updated);
  }

  // ── DELETE (admin, soft) ─────────────────────────────────────────────────────

  async deleteNotice(
    adminId: string,
    organizationId: string,
    id: string,
    requestId?: string,
  ) {
    const existing = await this.repo.findById(id, organizationId);
    if (!existing) {
      throw new NotFoundException({
        message: 'Notice not found',
        errors: { id: 'Notice does not exist in your organization' },
      });
    }
    await this.repo.softDelete(id, organizationId);

    this.audit.log({
      organizationId,
      actorId: adminId,
      targetId: id,
      targetType: 'Notice',
      action: 'delete',
      requestId,
    });

    return { success: true };
  }
}
