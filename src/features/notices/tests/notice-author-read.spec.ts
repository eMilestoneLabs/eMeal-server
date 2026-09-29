import { NoticesRepository } from '../repositories/notices.repository';

/**
 * Live-Test-16 ISSUE-13 ("Notice sent me also"): the author's OWN notice is
 * never unread for them — neither in the bell badge (unreadCount) nor in the
 * feed row (isRead) — and no NoticeRead row is written, so the admin's
 * "N read" counter is unchanged.
 */
describe('NoticesRepository — author never sees own notice as unread (ISSUE-13)', () => {
  const row = (id: string, createdBy: string) => ({
    id,
    organizationId: 'org-1',
    groupId: null,
    createdBy,
    title: 't',
    body: 'b',
    priority: 'normal',
    audience: 'all',
    pinned: false,
    publishedAt: new Date(),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const makeRepo = (rows: any[]) => {
    const prisma: any = {
      notice: {
        findMany: jest.fn().mockResolvedValue(rows),
        count: jest.fn().mockResolvedValue(7),
      },
      noticeRead: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    return { repo: new NoticesRepository(prisma), prisma };
  };

  it('unreadCount excludes notices the viewer authored (and keeps every other filter)', async () => {
    const { repo, prisma } = makeRepo([]);
    await repo.unreadCount('org-1', 'admin-1');
    const where = prisma.notice.count.mock.calls[0][0].where;
    expect(where.createdBy).toEqual({ not: 'admin-1' });
    expect(where.organizationId).toBe('org-1');
    expect(where.reads).toEqual({ none: { userId: 'admin-1' } });
  });

  it('list marks the viewer\'s own notice read, others by NoticeRead only', async () => {
    const { repo } = makeRepo([row('n-own', 'admin-1'), row('n-other', 'admin-2')]);
    const { data } = await repo.list('org-1', 'admin-1', { page: 1, limit: 20 });
    const byId = new Map(data.map((n) => [n.id, n]));
    expect(byId.get('n-own')!.isRead).toBe(true);
    expect(byId.get('n-other')!.isRead).toBe(false);
  });
});
