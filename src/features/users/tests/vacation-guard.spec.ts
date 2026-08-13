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
      // VAC-005/012: return-early ends the covering approved request.
      endCoveringVacationRequests: jest.fn().mockResolvedValue([]),
      // The ORG-WIDE vacation write. Separate from `update` because it must
      // also clear any per-group overrides, so "org-wide" genuinely governs
      // every group instead of being shadowed by one.
      setVacationModeOrgWide: jest
        .fn()
        .mockImplementation((_id: string, enabled: boolean) =>
          Promise.resolve({ ...baseUser, isVacationMode: enabled }),
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

  // REGRESSION GUARD (audit 2026-08-12). PATCH /users/me must NEVER be treated
  // as an org-wide vacation DECISION, because it cannot be distinguished from
  // an ordinary profile edit: AuthRepository.updateProfile puts
  // `'isVacationMode': user.isVacationMode` in the body UNCONDITIONALLY, so
  // every name / avatar / phone edit carries the field at its current value.
  // Applying org-wide semantics here (clearing per-group overrides) would wipe
  // a member's per-group vacation settings when they changed their avatar.
  // The DEDICATED endpoint is the only place org-wide intent is unambiguous —
  // which is exactly why it exists.
  it('a plain profile edit takes the ordinary single-statement update', async () => {
    const { service, usersRepo } = build({ requiresApproval: false });
    await service.updateMe('u1', { name: 'New Name' } as any);
    expect(usersRepo.update).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ name: 'New Name' }),
    );
    // No per-group reset may ride this route, under any name.
    expect(usersRepo.setVacationModeOrgWide).not.toHaveBeenCalled();
  });

  // SRS Module 03 VAC-012 (BUG-VAC-SELF-SERVE): OFF must PERSIST — the covering
  // approved request is ended so the read-time sync cannot force-re-enable.
  it('OFF via profile update ends the covering approved vacation request', async () => {
    const { service, usersRepo } = build({ requiresApproval: true, vacationOn: true });
    await service.updateMe('u1', { isVacationMode: false } as any);
    // PATCH /users/me carries no group scope, so this path is untouched by the
    // group-scoped Return Early and still ends every covering request.
    expect(usersRepo.endCoveringVacationRequests).toHaveBeenCalledWith('u1');
  });

  it('OFF via the dedicated toggle ends the covering approved vacation request', async () => {
    const { service, usersRepo } = build({ requiresApproval: true, vacationOn: true });
    await service.setVacationMode('u1', false);
    // No group scope on the org-wide toggle, so Return Early still ends EVERY
    // covering request as before — `undefined` takes the same repository
    // branch as the original single-argument call.
    expect(usersRepo.endCoveringVacationRequests).toHaveBeenCalledWith(
      'u1',
      undefined,
    );
    // The org-wide write goes through the AUTHORITATIVE path, which also
    // clears per-group overrides so no single group can shadow it. The plain
    // profile `update` must NOT be used here — that is what let an
    // admin-forced vacation report success while a group ignored it.
    expect(usersRepo.setVacationModeOrgWide).toHaveBeenCalledWith('u1', false);
    expect(usersRepo.update).not.toHaveBeenCalled();
  });

  it('ON never touches existing vacation requests', async () => {
    const { service, usersRepo } = build({ requiresApproval: false });
    await service.setVacationMode('u1', true);
    expect(usersRepo.endCoveringVacationRequests).not.toHaveBeenCalled();
  });
});
