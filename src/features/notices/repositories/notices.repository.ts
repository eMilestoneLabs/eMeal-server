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
  }): Promise<NoticeEntity> {
    const raw = await this.prisma.notice.create({
      data: { ...data, audience: data.audience ?? 'all' },
    });
    return this.toEntity(raw, false, 0);
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
    },
  ): Promise<{ data: NoticeEntity[]; total: number }> {
    const where = this.whereFor(organizationId, {
      groupId: opts.groupId,
      includeInactive: opts.includeInactive,
      onlyUnexpired: !opts.includeInactive,
      audiences: opts.audiences,
      forUserId,
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
  ): Promise<number> {
    const where = this.whereFor(organizationId, {
      groupId,
      includeInactive: false,
      onlyUnexpired: true,
      audiences,
      forUserId,
    });
    const rows = await this.prisma.notice.findMany({
      where,
      select: { id: true },
    });
    const ids = rows.map((r: any) => r.id);
    if (ids.length === 0) return 0;
    const reads = await this.prisma.noticeRead.findMany({
      where: { noticeId: { in: ids }, userId: forUserId },
      select: { noticeId: true },
    });
    return ids.length - new Set(reads.map((r: any) => r.noticeId)).size;
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
}
