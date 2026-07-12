import {
  Injectable,
  Logger,
  Inject,
  Optional,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';
import { NoticesRepository } from './repositories/notices.repository';
import { NoticeSerializer } from './serializers/notice.serializer';
import { AuditService } from '../../audit/audit.service';
import { ADMIN_ROLES } from '../../common/decorators/roles.decorator';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { UpdateNoticeDto } from './dto/update-notice.dto';
import { QueryNoticeDto } from './dto/query-notice.dto';
import { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeEventsService } from '../../realtime/services/realtime-events.service';
import { ConfigService } from '@nestjs/config';

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
    private readonly config: ConfigService,
    @Optional()
    @Inject('REALTIME_GATEWAY')
    private readonly realtime: RealtimeEventsService | null = null,
    // SRS Module 03 NTC-012/013: MinIO attachment uploads. @Optional so unit
    // tests construct the service unchanged (attachments then rejected).
    @Optional()
    @Inject(StorageService)
    private readonly storage: StorageService | null = null,
  ) {}

  // ── SRS Module 03 NTC-012/013 — attachment validation ──────────────────────

  /** Decode a base64 data URI → { buffer, mimeType }; null when not one. */
  private static decodeDataUri(
    data: string,
  ): { buffer: Buffer; mimeType: string } | null {
    const m = /^data:([\w.+/-]+);base64,(.+)$/s.exec(data);
    if (!m) return null;
    try {
      return { buffer: Buffer.from(m[2], 'base64'), mimeType: m[1] };
    } catch {
      return null;
    }
  }

  private static readonly IMAGE_TYPES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };

  private static readonly DOC_TYPES: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      'docx',
    'text/plain': 'txt',
  };

  /**
   * NTC-012: validate the (client-compressed) image — JPG/JPEG/PNG/WEBP,
   * decoded ≤100 KB — with the exact SRS rejection message.
   */
  private validateImageAttachment(data: string): {
    buffer: Buffer;
    mimeType: string;
    ext: string;
  } {
    const decoded = NoticesService.decodeDataUri(data);
    const ext = decoded && NoticesService.IMAGE_TYPES[decoded.mimeType];
    if (!decoded || !ext) {
      throw new BadRequestException({
        message: 'Unsupported image format. Use JPG, JPEG, PNG or WEBP.',
        errors: { imageData: 'Unsupported format' },
      });
    }
    const maxBytes =
      this.config.get<number>('NOTICE_IMAGE_MAX_KB', 100) * 1024;
    if (decoded.buffer.length > maxBytes) {
      throw new BadRequestException({
        message:
          'Unable to upload image. Please select an image smaller than 100 KB.',
        errors: { imageData: 'Image exceeds the 100 KB limit' },
      });
    }
    return { ...decoded, ext };
  }

  /** NTC-013: validate the document — PDF/DOC/DOCX/TXT, decoded ≤50 KB. */
  private validateDocumentAttachment(data: string): {
    buffer: Buffer;
    mimeType: string;
    ext: string;
  } {
    const decoded = NoticesService.decodeDataUri(data);
    const ext = decoded && NoticesService.DOC_TYPES[decoded.mimeType];
    if (!decoded || !ext) {
      throw new BadRequestException({
        message: 'Unsupported document format. Use PDF, DOC, DOCX or TXT.',
        errors: { documentData: 'Unsupported format' },
      });
    }
    const maxBytes = this.config.get<number>('NOTICE_DOC_MAX_KB', 50) * 1024;
    if (decoded.buffer.length > maxBytes) {
      throw new BadRequestException({
        message:
          'Unable to upload document. Please select a document smaller than 50 KB.',
        errors: { documentData: 'Document exceeds the 50 KB limit' },
      });
    }
    return { ...decoded, ext };
  }

  /** NTF-005: configurable bell retention window in days (default 30). */
  private retentionDays(): number {
    return (
      this.config.get<number>('groups.notificationRetentionDays') ?? 30
    );
  }

  private isAdmin(role: string): boolean {
    return (ADMIN_ROLES as readonly string[]).includes(role);
  }

  /**
   * #4: which notice audiences a role may see. Everyone sees 'all' (legacy
   * broadcast notices); admins additionally see 'admins' (request alerts),
   * members additionally see 'members'. Keeps admin-only alerts out of the
   * student bell and vice-versa.
   */
  private audiencesFor(role: string): string[] {
    return this.isAdmin(role) ? ['all', 'admins'] : ['all', 'members'];
  }

  // ── REQUEST ALERT (system → admins' bell) ───────────────────────────────────

  /**
   * #4: raise an in-app notice targeted at ORG ADMINS when a member submits a
   * request (vacation, correction, …) so it appears in the admin bell + unread
   * badge — the reliable in-app channel that complements the best-effort push.
   * Best-effort and never throws: the underlying request write must succeed even
   * if this alert fails. Org-wide (groupId null) so every admin sees it
   * regardless of their selected group; audience 'admins' hides it from members.
   */
  async createRequestAlert(params: {
    organizationId: string;
    groupId?: string | null;
    actorId: string;
    title: string;
    body: string;
    priority?: string;
    /**
     * Notification Center deep-link (command_3): the approval workflow this
     * alert should open when tapped (e.g. 'vacationRequests'). Omit for a
     * plain informational alert.
     */
    linkType?: string;
    /**
     * Visibility (command_3): 'admins' (default — request alerts to the admin
     * bell) or 'members' (decision notices to a member, paired with
     * [targetUserId]).
     */
    audience?: string;
    /** When set, ONLY this user sees the notice (approval/rejection decisions). */
    targetUserId?: string | null;
  }): Promise<void> {
    const audience = params.audience ?? 'admins';
    try {
      const notice = await this.repo.create({
        organizationId: params.organizationId,
        groupId: params.groupId ?? null,
        createdBy: params.actorId,
        title: params.title,
        body: params.body,
        priority: params.priority ?? 'high',
        audience,
        linkType: params.linkType ?? null,
        targetUserId: params.targetUserId ?? null,
        pinned: false,
        expiresAt: null,
      });
      // Live badge: reuse the notice-created realtime channel so an open bell
      // refreshes immediately (the widget re-fetches its unread count).
      this.realtime?.emitNoticeCreated(params.organizationId, notice.groupId, {
        organizationId: params.organizationId,
        groupId: notice.groupId,
        noticeId: notice.id,
        title: notice.title,
        priority: notice.priority,
        pinned: notice.pinned,
        publishedAt: notice.publishedAt.toISOString(),
        audience,
      });
    } catch (err) {
      this.logger.warn(
        `alert notice failed (request unaffected): ${(err as Error).message}`,
      );
    }
  }

  /**
   * command_3: a decision notice (approval / rejection) delivered to a single
   * member's bell, deep-linked to where they can see the outcome. Thin wrapper
   * over [createRequestAlert] with member audience + target — best-effort.
   */
  async createMemberAlert(params: {
    organizationId: string;
    groupId?: string | null;
    actorId: string;
    targetUserId: string;
    title: string;
    body: string;
    priority?: string;
    linkType?: string;
  }): Promise<void> {
    return this.createRequestAlert({
      ...params,
      audience: 'members',
    });
  }

  // ── CREATE (admin) ─────────────────────────────────────────────────────────

  async createNotice(
    adminId: string,
    organizationId: string,
    dto: CreateNoticeDto,
    requestId?: string,
  ) {
    // SRS Module 03 NTC-012/013: validate attachments BEFORE any write so a
    // rejected file never leaves a half-created notice behind.
    const image = dto.imageData
      ? this.validateImageAttachment(dto.imageData)
      : null;
    const doc = dto.documentData
      ? this.validateDocumentAttachment(dto.documentData)
      : null;
    if ((image || doc) && !this.storage) {
      throw new BadRequestException({
        message: 'Attachment storage is not available right now — publish without attachments or retry later.',
        errors: { imageData: 'Storage unavailable' },
      });
    }

    let notice = await this.repo.create({
      organizationId,
      groupId: dto.groupId ?? null,
      createdBy: adminId,
      title: dto.title,
      body: dto.body,
      priority: dto.priority ?? 'normal',
      pinned: dto.pinned ?? false,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      externalLinks: dto.externalLinks ?? [],
    });

    // Upload AFTER the row exists — the notice id keys the MinIO objects
    // (same base64-never-in-DB discipline as meal images).
    if (image || doc) {
      const patch: {
        imageUrl?: string | null;
        documentUrl?: string | null;
        documentName?: string | null;
      } = {};
      if (image) {
        patch.imageUrl = await this.storage!.uploadNoticeAttachment(
          organizationId,
          notice.id,
          image.buffer,
          image.mimeType,
          image.ext,
        );
      }
      if (doc) {
        patch.documentUrl = await this.storage!.uploadNoticeAttachment(
          organizationId,
          notice.id,
          doc.buffer,
          doc.mimeType,
          doc.ext,
        );
        patch.documentName =
          dto.documentName ?? `attachment.${doc.ext}`;
      }
      notice = await this.repo.update(notice.id, organizationId, patch);
    }

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
      audiences: this.audiencesFor(role),
      // NTF-005: bell feed retention (ignored for the admin includeInactive view).
      retentionDays: this.retentionDays(),
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
    const count = await this.repo.unreadCount(
      organizationId,
      userId,
      groupId,
      this.audiencesFor(role),
      this.retentionDays(),
    );
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

  async markAllRead(
    userId: string,
    role: string,
    organizationId: string,
    groupId?: string,
  ) {
    const updated = await this.repo.markAllRead(
      organizationId,
      userId,
      groupId,
      this.audiencesFor(role),
    );
    return { success: true, updated };
  }

  // ── DISMISS (member bell — NTF-006) ─────────────────────────────────────────

  /**
   * NTF-006: a member removes ONE notice from their OWN bell (per-user hide).
   * The shared notice is untouched for everyone else. Idempotent.
   */
  async dismissNotice(userId: string, organizationId: string, noticeId: string) {
    const notice = await this.repo.findById(noticeId, organizationId);
    if (!notice) {
      throw new NotFoundException({
        message: 'Notice not found',
        errors: { id: 'Notice does not exist in your organization' },
      });
    }
    await this.repo.dismiss(noticeId, userId);
    return { success: true };
  }

  /**
   * NTF-006: "Delete All" — a member clears every currently-visible notice from
   * their OWN bell. Returns how many were dismissed.
   */
  async dismissAllNotices(
    userId: string,
    role: string,
    organizationId: string,
    groupId?: string,
  ) {
    const updated = await this.repo.dismissAll(
      organizationId,
      userId,
      groupId,
      this.audiencesFor(role),
      this.retentionDays(),
    );
    return { success: true, dismissed: updated };
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
  //
  // FR-NOTX-004 (Pass 15 verified): soft delete flips isActive=false, and every
  // member-facing read (list, unread count) filters isActive=true — a deleted
  // notice vanishes from lists AND unread badges immediately. NoticeRead rows
  // are RETAINED by policy (audit trail of who saw it before deletion).

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
