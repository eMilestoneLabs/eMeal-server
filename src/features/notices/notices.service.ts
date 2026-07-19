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
import { RedisService } from '../../redis/redis.service';
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
import {
  compressImageToLimit,
  compressPdfToLimit,
} from './attachment-compression.util';

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
    // Perf (2026-07-19): Redis response cache for the two bell hot reads
    // (feed + unread-count — the only endpoints over budget in EVERY audit
    // run). @Optional so unit tests construct the service unchanged (cache
    // then simply off, byte-identical legacy behavior).
    @Optional()
    @Inject(RedisService)
    private readonly redis: RedisService | null = null,
  ) {}

  // ── Bell response cache (feed + unread-count) ──────────────────────────────
  // Keys are per-user (read/dismiss state and audience are per-user), TTL is a
  // safety net only — every mutation invalidates explicitly BEFORE its
  // realtime event fires, so a client refetching on the event always sees
  // fresh data. NOTICE_CACHE_TTL_SECONDS=0 disables (exact legacy path).
  // The member-gate ALWAYS runs live even on cache hits: a removed/blocked
  // member loses access instantly, cache or no cache.

  private static cacheTtlSeconds(): number {
    return parseInt(process.env.NOTICE_CACHE_TTL_SECONDS ?? '45', 10);
  }

  private feedCacheKey(
    organizationId: string,
    userId: string,
    groupId: string | undefined,
    page: number,
    limit: number,
    admin: boolean,
    includeInactive: boolean,
  ): string {
    return (
      `ntc:v1:${organizationId}:${userId}:feed:${groupId ?? '-'}:` +
      `${page}:${limit}:${admin ? 1 : 0}:${includeInactive ? 1 : 0}`
    );
  }

  private unreadCacheKey(
    organizationId: string,
    userId: string,
    groupId: string | undefined,
    role: string,
  ): string {
    return `ntc:v1:${organizationId}:${userId}:unread:${groupId ?? '-'}:${role}`;
  }

  /** Notice content changed for the whole org (create/update/delete/refresh). */
  private async invalidateOrgNoticeCache(organizationId: string): Promise<void> {
    if (NoticesService.cacheTtlSeconds() <= 0) return;
    await this.redis
      ?.deletePattern(`ntc:v1:${organizationId}:*`)
      .catch(() => undefined);
  }

  /** Only THIS user's read/dismiss state changed (markRead/dismiss/…). */
  private async invalidateUserNoticeCache(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    if (NoticesService.cacheTtlSeconds() <= 0) return;
    await this.redis
      ?.deletePattern(`ntc:v1:${organizationId}:${userId}:*`)
      .catch(() => undefined);
  }

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
   * NTC-012: validate the (client-compressed) image — JPG/JPEG/PNG/WEBP.
   * ISSUE-001 (Live-Test-10): an oversized image is AUTO-COMPRESSED server-side
   * (sharp ladder) to fit the configured limit; rejection with the exact SRS
   * message happens ONLY when even auto-compression cannot reach it.
   */
  private async validateImageAttachment(data: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    ext: string;
  }> {
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
      const compressed = await compressImageToLimit(decoded.buffer, maxBytes);
      if (compressed) {
        this.logger.log(
          `notice image auto-compressed ${decoded.buffer.length}B → ${compressed.buffer.length}B`,
        );
        return compressed;
      }
      throw new BadRequestException({
        message:
          'Unable to upload image. Please select an image smaller than 100 KB.',
        errors: { imageData: 'Image exceeds the 100 KB limit' },
      });
    }
    return { ...decoded, ext };
  }

  /**
   * NTC-013: validate the document — PDF/DOC/DOCX/TXT.
   * ISSUE-001 (Live-Test-10): an oversized PDF gets a best-effort structural
   * re-compression (pdf-lib) before the size gate; DOC/DOCX/TXT cannot be
   * recompressed losslessly, so they keep the strict limit. Rejection uses the
   * exact SRS message only when auto-compression cannot fit the limit.
   */
  private async validateDocumentAttachment(data: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    ext: string;
  }> {
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
      if (ext === 'pdf') {
        const compressed = await compressPdfToLimit(decoded.buffer, maxBytes);
        if (compressed) {
          this.logger.log(
            `notice pdf auto-compressed ${decoded.buffer.length}B → ${compressed.length}B`,
          );
          return { buffer: compressed, mimeType: decoded.mimeType, ext };
        }
      }
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
      // Live-Test-11 P1 (single-notification rule): collapse a repeat of the
      // SAME logical alert (same actor + workflow + scope + title) inside the
      // collapse window into ONE bell card — the existing notice is refreshed
      // (body + publishedAt) and re-surfaced as unread instead of stacking a
      // duplicate. Window is config-driven; 0 disables collapsing.
      const collapseHours = Number(
        this.config.get<number>('NOTICE_REQUEST_ALERT_COLLAPSE_HOURS', 12),
      );
      if (collapseHours > 0) {
        const existing = await this.repo.findCollapsibleAlert({
          organizationId: params.organizationId,
          groupId: params.groupId ?? null,
          createdBy: params.actorId,
          linkType: params.linkType ?? null,
          audience,
          targetUserId: params.targetUserId ?? null,
          title: params.title,
          since: new Date(Date.now() - collapseHours * 60 * 60 * 1000),
        });
        if (existing) {
          const refreshed = await this.repo.refreshAlert(existing.id, params.body);
          // Invalidate BEFORE the event so refetching bells see fresh data.
          await this.invalidateOrgNoticeCache(params.organizationId);
          this.realtime?.emitNoticeCreated(
            params.organizationId,
            params.groupId ?? null,
            {
              organizationId: params.organizationId,
              groupId: params.groupId ?? null,
              noticeId: existing.id,
              title: params.title,
              priority: params.priority ?? 'high',
              pinned: false,
              publishedAt: refreshed.publishedAt.toISOString(),
              audience,
            },
          );
          return;
        }
      }
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
      // Invalidate BEFORE the event so refetching bells see fresh data.
      await this.invalidateOrgNoticeCache(params.organizationId);
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
    // SRS Module 03 NTC-012/013: validate (and, when oversized, auto-compress
    // — ISSUE-001) attachments BEFORE any write so a rejected file never
    // leaves a half-created notice behind.
    const image = dto.imageData
      ? await this.validateImageAttachment(dto.imageData)
      : null;
    const doc = dto.documentData
      ? await this.validateDocumentAttachment(dto.documentData)
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
    // Invalidate BEFORE the event so refetching bells see fresh data.
    await this.invalidateOrgNoticeCache(organizationId);
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
    const includeInactive = admin ? !!query.includeInactive : false;

    // Members may only request notices for a group they actively belong to —
    // prevents cross-group leakage inside the same organization.
    // command_6 perf: the list query is org+audience-scoped itself, so the
    // membership gate runs CONCURRENTLY with it; the 403 is still thrown
    // before anything is returned. The gate is ALWAYS live (never cached).
    const memberGate =
      !admin && query.groupId
        ? this.repo.isActiveMember(query.groupId, userId)
        : Promise.resolve(true);

    const fetchPage = async () => {
      const { data, total } = await this.repo.list(organizationId, userId, {
        groupId: query.groupId,
        includeInactive,
        page,
        limit,
        withReadCount: admin,
        audiences: this.audiencesFor(role),
        // NTF-005: bell feed retention (ignored for the admin includeInactive view).
        retentionDays: this.retentionDays(),
      });
      return { data: NoticeSerializer.toList(data), total, page, limit };
    };

    const ttl = NoticesService.cacheTtlSeconds();
    if (ttl > 0 && this.redis) {
      const cacheKey = this.feedCacheKey(
        organizationId, userId, query.groupId, page, limit, admin, includeInactive,
      );
      const [member, cached] = await Promise.all([
        memberGate,
        this.redis.get(cacheKey).catch(() => null),
      ]);
      this.assertNoticeMember(member);
      if (cached) {
        try {
          return JSON.parse(cached);
        } catch {
          /* corrupt cache entry → recompute below */
        }
      }
      const response = await fetchPage();
      void this.redis
        .set(cacheKey, JSON.stringify(response), ttl)
        .catch(() => undefined);
      return response;
    }

    // Legacy path (cache disabled / redis absent) — behavior unchanged.
    const [member, response] = await Promise.all([memberGate, fetchPage()]);
    this.assertNoticeMember(member);
    return response;
  }

  /** Shared 403 for the group-membership gate (feed path). */
  private assertNoticeMember(member: boolean): void {
    if (!member) {
      throw new ForbiddenException({
        message: 'You are not a member of this group',
        errors: { groupId: 'Not an active member' },
      });
    }
  }

  // ── UNREAD COUNT (members + admins) ─────────────────────────────────────────

  async getUnreadCount(
    userId: string,
    role: string,
    organizationId: string,
    groupId?: string,
  ) {
    // command_6 perf: membership gate + unread count in ONE parallel wave
    // (was two sequential round trips for members); non-member response is
    // still { count: 0 }. The gate is ALWAYS live — only the count is cached.
    const memberGate =
      !this.isAdmin(role) && groupId
        ? this.repo.isActiveMember(groupId, userId)
        : Promise.resolve(true);

    const ttl = NoticesService.cacheTtlSeconds();
    if (ttl > 0 && this.redis) {
      const cacheKey = this.unreadCacheKey(organizationId, userId, groupId, role);
      const [member, cached] = await Promise.all([
        memberGate,
        this.redis.get(cacheKey).catch(() => null),
      ]);
      if (!member) return { count: 0 };
      if (cached != null) {
        const parsed = Number(cached);
        if (Number.isFinite(parsed)) return { count: parsed };
      }
      const count = await this.repo.unreadCount(
        organizationId,
        userId,
        groupId,
        this.audiencesFor(role),
        this.retentionDays(),
      );
      void this.redis.set(cacheKey, String(count), ttl).catch(() => undefined);
      return { count };
    }

    // Legacy path (cache disabled / redis absent) — behavior unchanged.
    const [member, count] = await Promise.all([
      memberGate,
      this.repo.unreadCount(
        organizationId,
        userId,
        groupId,
        this.audiencesFor(role),
        this.retentionDays(),
      ),
    ]);
    if (!member) return { count: 0 };
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
    await this.invalidateUserNoticeCache(organizationId, userId);
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
    await this.invalidateUserNoticeCache(organizationId, userId);
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
    await this.invalidateUserNoticeCache(organizationId, userId);
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
    await this.invalidateUserNoticeCache(organizationId, userId);
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

    await this.invalidateOrgNoticeCache(organizationId);
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
    await this.invalidateOrgNoticeCache(organizationId);

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
