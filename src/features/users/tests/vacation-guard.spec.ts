/**
 * Live-mobile fix (2026-07-05): PATCH /users/me previously wrote
 * isVacationMode UNGUARDED, silently bypassing the FR-VACX-001 approval
 * workflow that the dedicated vacation endpoint enforces. updateMe now
 * applies the same self-service guard when turning vacation ON; turning it
 * OFF (early return from an approved vacation) stays always allowed.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { UsersService } from '../users.service';

describe('users service — PATCH /users/me vacation approval guard', () => {
  const baseUser = {
    id: 'u1',
    email: 'u@example.com',
    phone: null,
    avatarUrl: null,
    organizationId: 'org1',
    isVacationMode: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  function build(opts: { requiresApproval: boolean; vacationOn?: boolean }) {
    const usersRepo: any = {
      findById: jest
        .fn()
        .mockResolvedValue({ ...baseUser, isVacationMode: opts.vacationOn ?? false }),
      vacationRequiresApproval: jest.fn().mockResolvedValue(opts.requiresApproval),
      update: jest
        .fn()
        .mockImplementation((_id: string, data: any) =>
          Promise.resolve({ ...baseUser, ...data }),
        ),
    };
    const storage: any = { keyFromUrl: jest.fn(), deleteImage: jest.fn() };
    return { service: new UsersService(usersRepo, storage), usersRepo };
  }

  it('rejects turning vacation ON when the group requires approval (422 VACATION_REQUIRES_APPROVAL)', async () => {
    const { service, usersRepo } = build({ requiresApproval: true });
    await expect(
      service.updateMe('u1', { isVacationMode: true } as any),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(usersRepo.update).not.toHaveBeenCalled();
  });

  it('allows turning vacation ON when no group requires approval', async () => {
    const { service, usersRepo } = build({ requiresApproval: false });
    await service.updateMe('u1', { isVacationMode: true } as any);
    expect(usersRepo.update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ isVacationMode: true }),
    );
  });

  it('always allows turning vacation OFF (early return), even under approval policy', async () => {
    const { service, usersRepo } = build({ requiresApproval: true, vacationOn: true });
    await service.updateMe('u1', { isVacationMode: false } as any);
    expect(usersRepo.vacationRequiresApproval).not.toHaveBeenCalled();
    expect(usersRepo.update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ isVacationMode: false }),
    );
  });
});
