/**
 * Email case-insensitivity (2026-07-04 login-lockout fix): accounts created
 * before the fix store mixed-case emails, so lookups must match insensitively
 * and the signup dup-check must not allow case-variant duplicates.
 */
import { UsersRepository } from '../repositories/users.repository';

describe('users repository — case-insensitive email matching', () => {
  const prisma: any = {
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const repo = new UsersRepository(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('findByIdentifier matches emails with mode: insensitive', async () => {
    await repo.findByIdentifier('  Manas.B@Gmail.com ');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'Manas.B@Gmail.com', mode: 'insensitive' } },
      }),
    );
  });

  // UNI-002 (Live-Test-5): a 10-digit Indian mobile also matches its legacy
  // stored variants (+91 / 91 / 0 prefixes) so old rows stay reachable at
  // login and can never be duplicated by formatting differences.
  it('findByIdentifier matches phone canonical + legacy variants (trimmed)', async () => {
    await repo.findByIdentifier(' 9876543210 ');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          phone: {
            in: ['9876543210', '+919876543210', '919876543210', '09876543210'],
          },
        },
      }),
    );
  });

  it('findByIdentifier leaves non-Indian phone formats exact', async () => {
    await repo.findByIdentifier('+14155552671');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: { in: ['+14155552671'] } } }),
    );
  });

  it('existsByEmail (signup dup-check) is case-insensitive', async () => {
    await repo.existsByEmail('USER@example.COM');
    expect(prisma.user.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'USER@example.COM', mode: 'insensitive' } },
      }),
    );
  });
});
