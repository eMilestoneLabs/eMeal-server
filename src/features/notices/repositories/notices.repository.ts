import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { NoticeEntity } from '../entities/notice.entity';

/**
 * NoticesRepository — Prisma access for the Notice + NoticeRead models.
 * Strictly org-scoped (organizationId always supplied by the service from the
 * JWT). isRead is computed by joining NoticeRead for the requesting user.
 */
@Injectable()
export class NoticesRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(raw: any, isRead = false, readCount = 0): NoticeEntity {
    return new NoticeEntity({
      id: raw.id,
      organizationId: raw.organizationId,
      groupId: raw.groupId ?? null,
      createdBy: raw.createdBy,
      title: raw.title,
      body: raw.body,
      priority: raw.priority,
      audience: raw.audience ?? 'all',
      linkType: raw.linkType ?? null,
      targetUserId: raw.targetUserId ?? null,
      pinned: raw.pinned,
      imageUrl: raw.imageUrl ?? null,
      documentUrl: raw.documentUrl ?? null,
      documentName: raw.documentName ?? null,
      externalLinks: raw.externalLinks ?? [],
      publishedAt: raw.publishedAt,
      expiresAt: raw.expiresAt ?? null,
      isActive: raw.isActive,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      isRead,
      readCount,
    });
  }

  /** Visibility filter shared by list + unread count. */
  private whereFor(
    organizationId: string,
    opts: {
      groupId?: string;
      includeInactive?: boolean;
      onlyUnexpired?: boolean;
      audiences?: string[];
      forUserId?: string;
      // NTF-006: hide notices this user has dismissed from their bell.
      excludeDismissedFor?: string;
      // NTF-005: retention window in days — hide notices older than this from
      // the bell feed (0/undefined = no retention cutoff).
      retentionDays?: number;
    },
  ): any {
    const where: any = { organizationId };
    if (!opts.includeInactive) where.isActive = true;
    // #4: audience gate — admins receive 'all'+'admins', members 'all'+'members'.
    // Callers that omit audiences (or pass undefined) see everything (legacy).
    if (opts.audiences && opts.audiences.length) {
      where.audience = { in: opts.audiences };
    }
    // Members see org-wide notices (groupId null) PLUS their own group's notices.
    if (opts.groupId) {
      where.OR = [{ groupId: opts.groupId }, { groupId: null }];
    }
    const and: any[] = [];
    if (opts.onlyUnexpired) {
      and.push({ OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }] });
    }
    // command_3: a per-member targeted notice (approval/rejection decision) is
    // visible ONLY to that member; untargeted (null) notices stay visible to
    // everyone in scope. Applied whenever the requesting user is known.
    if (opts.forUserId) {
      and.push({
        OR: [{ targetUserId: null }, { targetUserId: opts.forUserId }],
      });
    }
    // NTF-006: exclude notices this user has dismissed from their own bell.
    if (opts.excludeDismissedFor) {
      and.push({
        NOT: {
          reads: {
            some: {
              userId: opts.excludeDismissedFor,
              dismissedAt: { not: null },
            },
          },
        },
      });
    }
    // NTF-005: retention cutoff — bell feed only shows recent notices.
    if (opts.retentionDays && opts.retentionDays > 0) {
      const cutoff = new Date(
        Date.now() - opts.retentionDays * 24 * 60 * 60 * 1000,
      );
      and.push({ publishedAt: { gte: cutoff } });
    }
    if (and.length) where.AND = and;
    return where;
  }

  async isActiveMember(groupId: string, userId: string): Promise<boolean> {
    const m = await this.prisma.groupMember.findFirst({
      where: { groupId, userId, status: 'active' },
      select: { id: true },
    });
    return !!m;
  }

  async create(data: {
    organizationId: string;
    groupId: string | null;
    createdBy: string;
    title: string;
    body: string;
    priority: string;
    audience?: string;
    linkType?: string | null;
    targetUserId?: string | null;
    pinned: boolean;
    expiresAt: Date | null;
    // NTC-003: external links ride the create; attachment URLs are patched
    // in AFTER upload (the notice id keys the MinIO objects).
    externalLinks?: string[];
  }): Promise<NoticeEntity> {
    const raw = await this.prisma.notice.create({
      data: { ...data, audience: data.audience ?? 'all' },
    });
    return this.toEntity(raw, false, 0);
  }

  /**
   * Live-Test-11 P1 (single-notification rule): the still-active alert this
   * new request would duplicate — same actor, workflow deep-link, scope and
   * title within the collapse window. Indexed on organizationId.
   */
  async findCollapsibleAlert(params: {
    organizationId: string;
    groupId: string | null;
    createdBy: string;
    linkType: string | null;
    audience: string;
    targetUserId: string | null;
    title: string;
    since: Date;
  }): Promise<{ id: string } | null> {
    return this.prisma.notice.findFirst({
      where: {
        organizationId: params.organizationId,
        groupId: params.groupId,
        createdBy: params.createdBy,
        linkType: params.linkType,
        audience: params.audience,
        targetUserId: params.targetUserId,
        title: params.title,
        isActive: true,
        deletedAt: null,
        publishedAt: { gte: params.since },
      },
      select: { id: true },
    });
  }

  /**
   * Refresh a collapsed alert: newest body, bumped publishedAt, and reads
   * cleared so it re-surfaces as UNREAD in every recipient's bell (a repeat
   * request must alert again — as one card, never a duplicate).
   */
  async refreshAlert(
    noticeId: string,
    body: string,
  ): Promise<{ publishedAt: Date }> {
    const [updated] = await this.prisma.$transaction([
      this.prisma.notice.update({
        where: { id: noticeId },
        data: { body, publishedAt: new Date() },
        select: { publishedAt: true },
      }),
      this.prisma.noticeRead.deleteMany({ where: { noticeId } }),
    ]);
    return updated;
  }

  async findById(id: string, organizationId: string): Promise<NoticeEntity | null> {
    const raw = await this.prisma.notice.findFirst({
      where: { id, organizationId },
    });
    return raw ? this.toEntity(raw) : null;
  }

  async list(
    organizationId: string,
    forUserId: string,
    opts: {
      groupId?: string;
      includeInactive?: boolean;
      page: number;
      limit: number;
      withReadCount?: boolean;
      audiences?: string[];
      retentionDays?: number;
    },
  ): Promise<{ data: NoticeEntity[]; total: number }> {
    const where = this.whereFor(organizationId, {
      groupId: opts.groupId,
      includeInactive: opts.includeInactive,
      onlyUnexpired: !opts.includeInactive,
      audiences: opts.audiences,
      forUserId,
      // NTF-005/006: dismissal + retention apply to the live bell feed only
      // (not the admin includeInactive management view).
      excludeDismissedFor: opts.includeInactive ? undefined : forUserId,
      retentionDays: opts.includeInactive ? undefined : opts.retentionDays,
    });
    const skip = (opts.page - 1) * opts.limit;

    const [rows, total] = await Promise.all([
      this.prisma.notice.findMany({
        where,
        orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
        skip,
        take: opts.limit,
      }),
      this.prisma.notice.count({ where }),
    ]);

    const ids = rows.map((r: any) => r.id);
    const reads = ids.length
      ? await this.prisma.noticeRead.findMany({
          where: { noticeId: { in: ids }, userId: forUserId },
          select: { noticeId: true },
        })
      : [];
    const readSet = new Set(reads.map((r: any) => r.noticeId));

    let countByNotice = new Map<string, number>();
    if (opts.withReadCount && ids.length) {
      const grouped = await this.prisma.noticeRead.groupBy({
        by: ['noticeId'],
        where: { noticeId: { in: ids } },
        _count: { noticeId: true },
      });
      countByNotice = new Map(
        grouped.map((g: any) => [g.noticeId, g._count.noticeId]),
      );
    }

    const data = rows.map((r: any) =>
      this.toEntity(r, readSet.has(r.id), countByNotice.get(r.id) ?? 0),
    );
    return { data, total };
  }

  async unreadCount(
    organizationId: string,
    forUserId: string,
    groupId?: string,
    audiences?: string[],
    retentionDays?: number,
  ): Promise<number> {
    const where = this.whereFor(organizationId, {
      groupId,
      includeInactive: false,
      onlyUnexpired: true,
      audiences,
      forUserId,
      // NTF-006/005: dismissed + retention-aged notices never count as unread.
      excludeDismissedFor: forUserId,
      retentionDays,
    });
    // command_6 perf: ONE indexed anti-join count — unread = a visible notice
    // with NO NoticeRead row for this user (identical semantics to the former
    // two sequential findMany waves, which shipped every visible notice id +
    // its read rows to Node just to diff set sizes). The (noticeId, userId)
    // unique index drives the NONE filter, so the DB returns just the number.
    return this.prisma.notice.count({
      where: {
        ...where,
        reads: { none: { userId: forUserId } },
      },
    });
  }

  async update(
    id: string,
    organizationId: string,
    data: {
      title?: string;
      body?: string;
      priority?: string;
      pinned?: boolean;
      expiresAt?: Date | null;
      isActive?: boolean;
      // NTC-012/013: MinIO attachment URLs patched in after upload.
      imageUrl?: string | null;
      documentUrl?: string | null;
      documentName?: string | null;
    },
  ): Promise<NoticeEntity> {
    await this.prisma.notice.updateMany({ where: { id, organizationId }, data });
    return this.findById(id, organizationId) as Promise<NoticeEntity>;
  }

  async softDelete(id: string, organizationId: string): Promise<NoticeEntity> {
    await this.prisma.notice.updateMany({
      where: { id, organizationId },
      data: { isActive: false, deletedAt: new Date() },
    });
    return this.findById(id, organizationId) as Promise<NoticeEntity>;
  }

  /** Idempotent — a repeat read is a no-op (unique noticeId+userId). */
  async markRead(noticeId: string, userId: string): Promise<void> {
    await this.prisma.noticeRead.upsert({
      where: { noticeId_userId: { noticeId, userId } },
      create: { noticeId, userId },
      update: {},
    });
  }

  /** Marks every currently-visible notice as read for the user. Returns count. */
  async markAllRead(
    organizationId: string,
    userId: string,
    groupId?: string,
    audiences?: string[],
  ): Promise<number> {
    const where = this.whereFor(organizationId, {
      groupId,
      includeInactive: false,
      onlyUnexpired: true,
      audiences,
      forUserId: userId,
    });
    const rows = await this.prisma.notice.findMany({
      where,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const existing = await this.prisma.noticeRead.findMany({
      where: { noticeId: { in: rows.map((r: any) => r.id) }, userId },
      select: { noticeId: true },
    });
    const have = new Set(existing.map((r: any) => r.noticeId));
    const toCreate = rows
      .filter((r: any) => !have.has(r.id))
      .map((r: any) => ({ noticeId: r.id, userId }));
    if (toCreate.length === 0) return 0;
    await this.prisma.noticeRead.createMany({ data: toCreate });
    return toCreate.length;
  }

  /**
   * NTF-006: dismiss ONE notice from a single user's bell (per-user hide). Also
   * marks it read. Idempotent via the (noticeId,userId) unique key.
   */
  async dismiss(noticeId: string, userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.noticeRead.upsert({
      where: { noticeId_userId: { noticeId, userId } },
      create: { noticeId, userId, dismissedAt: now },
      update: { dismissedAt: now },
    });
  }

  /**
   * NTF-006: dismiss ALL currently-visible notices from a user's bell. Returns
   * the number affected. Existing read rows are flipped to dismissed; missing
   * rows are created dismissed.
   */
  async dismissAll(
    organizationId: string,
    userId: string,
    groupId?: string,
    audiences?: string[],
    retentionDays?: number,
  ): Promise<number> {
    const where = this.whereFor(organizationId, {
      groupId,
      includeInactive: false,
      onlyUnexpired: true,
      audiences,
      forUserId: userId,
      excludeDismissedFor: userId, // already-dismissed rows are skipped
      retentionDays,
    });
    const rows = await this.prisma.notice.findMany({
      where,
      select: { id: true },
    });
    if (rows.length === 0) return 0;

    const now = new Date();
    const existing = await this.prisma.noticeRead.findMany({
      where: { noticeId: { in: rows.map((r: any) => r.id) }, userId },
      select: { noticeId: true },
    });
    const have = new Set(existing.map((r: any) => r.noticeId));

    const toCreate = rows
      .filter((r: any) => !have.has(r.id))
      .map((r: any) => ({ noticeId: r.id, userId, dismissedAt: now }));

    await this.prisma.$transaction([
      ...(have.size
        ? [
            this.prisma.noticeRead.updateMany({
              where: { noticeId: { in: [...have] }, userId },
              data: { dismissedAt: now },
            }),
          ]
        : []),
      ...(toCreate.length
        ? [this.prisma.noticeRead.createMany({ data: toCreate })]
        : []),
    ]);
    return rows.length;
  }
}
