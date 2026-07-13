import { UsersRepository } from '../repositories/users.repository';

/**
 * command_6 perf: GET /users/me now resolves the vacation flag from a
 * prefetched bundle (one parallel DB wave) instead of the sequential
 * syncVacationExpiry → findById path. These tests pin the flag rules to the
 * original semantics (Pass 11 FR-VACX-006):
 *   • approved request covers today + flag OFF  → flip ON
 *   • flag ON + approved requests exist + none covers today → flip OFF
 *   • pure-toggle users (no approved requests at all) are NEVER touched
 */
describe('UsersRepository.resolveVacationFlagPrefetched (command_6 perf bundle)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const coveringRows = [
    { startDate: new Date(Date.now() - 2 * DAY), endDate: new Date(Date.now() + 2 * DAY) },
  ];
  const endedRows = [
    { startDate: new Date(Date.now() - 10 * DAY), endDate: new Date(Date.now() - 5 * DAY) },
  ];

  let prisma: any;
  let repo: UsersRepository;

  beforeEach(() => {
    prisma = {
      user: { update: jest.fn().mockResolvedValue({}) },
      vacationRequest: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    repo = new UsersRepository(prisma);
  });

  it('flips ON when an approved request covers today and the flag is off', async () => {
    const flag = await repo.resolveVacationFlagPrefetched(
      'u1', false, 'Asia/Kolkata', coveringRows,
    );
    expect(flag).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { isVacationMode: true },
    });
  });

  it('keeps the flag on while a covering request is active (no write)', async () => {
    const flag = await repo.resolveVacationFlagPrefetched(
      'u1', true, 'Asia/Kolkata', coveringRows,
    );
    expect(flag).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('flips OFF when the flag is on, requests exist, and none covers today', async () => {
    const flag = await repo.resolveVacationFlagPrefetched(
      'u1', true, 'Asia/Kolkata', endedRows,
    );
    expect(flag).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { isVacationMode: false },
    });
    // near-window rows already prove hasAnyApproved — no fallback lookup
    expect(prisma.vacationRequest.findFirst).not.toHaveBeenCalled();
  });

  it('flips OFF via the fallback lookup when approved requests exist only outside the near window', async () => {
    prisma.vacationRequest.findFirst.mockResolvedValue({ id: 'v1' });
    const flag = await repo.resolveVacationFlagPrefetched('u1', true, 'Asia/Kolkata', []);
    expect(flag).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { isVacationMode: false },
    });
  });

  it('never touches pure-toggle users (flag on, zero approved requests anywhere)', async () => {
    const flag = await repo.resolveVacationFlagPrefetched('u1', true, 'Asia/Kolkata', []);
    expect(flag).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('common case (flag off, no near rows) costs zero extra queries', async () => {
    const flag = await repo.resolveVacationFlagPrefetched('u1', false, 'Asia/Kolkata', []);
    expect(flag).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.vacationRequest.findFirst).not.toHaveBeenCalled();
  });
});
