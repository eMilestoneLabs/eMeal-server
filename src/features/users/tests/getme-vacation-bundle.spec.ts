import { UsersRepository } from '../repositories/users.repository';

/**
 * command_6 perf: GET /users/me now resolves the vacation flag from a
 * prefetched bundle (one parallel DB wave) instead of the sequential
 * syncVacationExpiry → findById path. These tests pin the flag rules to the
 * original semantics (Pass 11 FR-VACX-006), tightened by Live-Test-8
 * ISSUE-007:
 *   • approved request covers today + flag OFF  → flip ON
 *   • flag ON + a request that RECENTLY ENDED (inside the ±48h prefetch
 *     margin) + none covers today → flip OFF (auto-resume)
 *   • toggle-mode flags are NEVER force-cleared — the old "any approved
 *     request ever" fallback wrongly resumed manual vacations for members
 *     with historical requests, exposing them to auto-Present billing.
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
    // near-window rows already prove the request-driven resume — no lookup
    expect(prisma.vacationRequest.findFirst).not.toHaveBeenCalled();
  });

  it('keeps a manual toggle ON when approved requests exist only OUTSIDE the near window (Live-Test-8: no force-clear)', async () => {
    prisma.vacationRequest.findFirst.mockResolvedValue({ id: 'v1' });
    const flag = await repo.resolveVacationFlagPrefetched('u1', true, 'Asia/Kolkata', []);
    expect(flag).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
    // The "any approved request ever" fallback query is gone entirely.
    expect(prisma.vacationRequest.findFirst).not.toHaveBeenCalled();
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
