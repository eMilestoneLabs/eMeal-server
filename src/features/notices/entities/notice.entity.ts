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
  /**
   * Notification Center deep-link (command_3): when set, tapping the notice
   * opens the related approval workflow. Maps to a Flutter screen (e.g.
   * 'vacationRequests' | 'correctionRequests'). null/undefined = plain notice.
   */
  linkType?: string | null;
  /**
   * Notification Center (command_3): per-member targeted notice. When set, only
   * this user sees it (approval/rejection decisions). null = audience-scoped.
   */
  targetUserId?: string | null;
  pinned: boolean;
  // SRS Module 03 NTC-003/012/013: optional rich content (MinIO URLs).
  imageUrl: string | null;
  documentUrl: string | null;
  documentName: string | null;
  externalLinks: string[];
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
