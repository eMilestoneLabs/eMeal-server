/**
 * NoticeEntity — domain shape decoupled from the Prisma model. isRead / readCount
 * are computed per request (never columns on the table).
 */
export class NoticeEntity {
  id: string;
  organizationId: string;
  groupId: string | null;
  createdBy: string;
  title: string;
  body: string;
  priority: string;
  /** Visibility gate: 'all' | 'admins' | 'members' (#4). */
  audience: string;
  pinned: boolean;
  publishedAt: Date;
  expiresAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  /** Computed for the requesting user. */
  isRead?: boolean;
  /** Admin-facing: how many members have read this notice. */
  readCount?: number;

  constructor(data: Partial<NoticeEntity>) {
    Object.assign(this, data);
  }
}
