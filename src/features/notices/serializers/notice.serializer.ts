import { NoticeEntity } from '../entities/notice.entity';

/**
 * NoticeSerializer — converts a NoticeEntity to the exact Flutter JSON contract
 * (lib/shared/models/notice_model.dart). Dates are ISO-8601 strings; groupId is
 * null for organization-wide notices.
 */
export class NoticeSerializer {
  static toResponse(n: NoticeEntity): Record<string, unknown> {
    return {
      id: n.id,
      organizationId: n.organizationId,
      groupId: n.groupId ?? null,
      createdBy: n.createdBy,
      title: n.title,
      body: n.body,
      priority: n.priority,
      audience: n.audience ?? 'all',
      pinned: n.pinned,
      publishedAt: n.publishedAt.toISOString(),
      expiresAt: n.expiresAt ? n.expiresAt.toISOString() : null,
      isActive: n.isActive,
      isRead: n.isRead ?? false,
      readCount: n.readCount ?? 0,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    };
  }

  static toList(notices: NoticeEntity[]): Record<string, unknown>[] {
    return notices.map((n) => this.toResponse(n));
  }
}
