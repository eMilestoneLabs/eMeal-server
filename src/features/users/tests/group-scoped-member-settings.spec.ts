/**
 * Group-scoped Personal Auto-Attendance (ATT-010) and group-scoped Return
 * Early (SRS Module 03 VAC-005/012).
 *
 * Both settings were USER-level only, so one toggle governed every group a
 * member belonged to: enabling auto-attendance while looking at group A also
 * auto-marked — and billed — them in group B, and returning early from group A
 * truncated a separately-approved group-B vacation.
 *
 * The scope is carried by an OPTIONAL `groupId`. These tests pin BOTH halves:
 *
 *   • WITHOUT it, every path must behave exactly as it always did. That is the
 *     compatibility contract for shipped APKs, which never send it.
 *   • WITH it, only the named membership is touched, and the id is validated
 *     against the TARGET user's ACTIVE membership inside the CALLER's
 *     organization — a guessed or foreign id must never reach a write.
 */
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UsersService } from '../users.service';
import {
  DefaultAttendanceDto,
  VacationModeDto,
} from '../dto/update-user.dto';

const build = (opts: { membershipFound?: boolean } = {}) => {
  const usersRepo: any = {
    findById: jest.fn().mockResolvedValue({ id: 'u1', isVacationMode: true }),
    update: jest.fn().mockResolvedValue({
      id: 'u1',
      isVacationMode: false,
      isDefaultAttendance: true,
    }),
    endCoveringVacationRequests: jest.fn().mockResolvedValue([]),
    // ORG-WIDE vacation write: user flag + clearing every per-group override,
    // in one round trip, so no single group can shadow an org-wide decision.
    setVacationModeOrgWide: jest
      .fn()
      .mockImplementation((_id: string, enabled: boolean) =>
        Promise.resolve({ id: 'u1', isVacationMode: enabled })),
    vacationRequiresApproval: jest.fn().mockResolvedValue(false),
    findActiveMembershipId: jest
      .fn()
      .mockResolvedValue(opts.membershipFound === false ? null : 'gm_1'),
    // Atomic validate+write: returns whether a row matched. `false` is how a
    // foreign / inactive / concurrently-removed membership now surfaces.
    setMemberDefaultAttendance: jest
      .fn()
      .mockResolvedValue(opts.membershipFound !== false),
    setMemberVacationMode: jest
      .fn()
      .mockResolvedValue(opts.membershipFound !== false),
    getPushTarget: jest.fn().mockResolvedValue(null),
  };
  const service = new UsersService(
    usersRepo,
    { upload: jest.fn() } as any,
    { log: jest.fn() } as any,
  );
  return { service, usersRepo };
};

describe('group-scoped member settings', () => {
  // ── ① Personal Auto-Attendance ───────────────────────────────────────────

  describe('setDefaultAttendance', () => {
    it('COMPATIBILITY: no groupId → the original user-level write, untouched', async () => {
      const { service, usersRepo } = build();
      const res: any = await service.setDefaultAttendance('u1', true);

      expect(usersRepo.update).toHaveBeenCalledWith('u1', {
        isDefaultAttendance: true,
      });
      expect(usersRepo.setMemberDefaultAttendance).not.toHaveBeenCalled();
      // No membership lookup is issued when no scope was asked for.
      expect(usersRepo.findActiveMembershipId).not.toHaveBeenCalled();
      expect(res.groupId).toBeUndefined();
    });

    it('with groupId → writes ONLY the membership; the user flag is left alone', async () => {
      const { service, usersRepo } = build();
      const res: any = await service.setDefaultAttendance('u1', true, {
        groupId: 'grp_A',
        organizationId: 'org1',
      });

      expect(usersRepo.setMemberDefaultAttendance).toHaveBeenCalledWith(
        'u1',
        'grp_A',
        'org1',
        true,
      );
      // The user-level flag stays the inherited default for other groups.
      expect(usersRepo.update).not.toHaveBeenCalled();
      expect(res.groupId).toBe('grp_A');
      expect(res.isDefaultAttendance).toBe(true);
    });

    it('turning it OFF for one group is also membership-only', async () => {
      const { service, usersRepo } = build();
      await service.setDefaultAttendance('u1', false, {
        groupId: 'grp_A',
        organizationId: 'org1',
      });
      expect(usersRepo.setMemberDefaultAttendance).toHaveBeenCalledWith(
        'u1',
        'grp_A',
        'org1',
        false,
      );
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it('SECURITY: a groupId the user is not an active member of is rejected', async () => {
      const { service, usersRepo } = build({ membershipFound: false });
      await expect(
        service.setDefaultAttendance('u1', true, {
          groupId: 'grp_FOREIGN',
          organizationId: 'org1',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // The scoped write IS issued — it carries the membership + organization
      // filter itself, so a foreign group simply matches NO row (count 0) and
      // the service turns that into the same 403. Nothing is mutated, and
      // there is no validate-then-write window to race. What must never
      // happen is a fall-through to the USER-level flag:
      expect(usersRepo.update).not.toHaveBeenCalled();
      expect(usersRepo.setMemberDefaultAttendance).toHaveBeenCalledWith(
        'u1',
        'grp_FOREIGN',
        'org1',
        true,
      );
    });

    it('SECURITY: validation is scoped to the CALLER organization', async () => {
      const { service, usersRepo } = build();
      await service.setDefaultAttendance('u1', true, {
        groupId: 'grp_A',
        organizationId: 'org1',
      });
      // Tenant isolation now rides the WRITE itself (updateMany where-clause
      // carries status:'active' + the organization relation), so the caller org
      // must reach the writer.
      expect(usersRepo.setMemberDefaultAttendance).toHaveBeenCalledWith(
        'u1',
        'grp_A',
        'org1',
        true,
      );
    });
  });

  // ── ③ Return Early ───────────────────────────────────────────────────────

  describe('setVacationMode — Return Early', () => {
    it('COMPATIBILITY: no groupId → ends EVERY covering request, as before', async () => {
      const { service, usersRepo } = build();
      await service.setVacationMode('u1', false, {
        id: 'u1',
        organizationId: 'org1',
      });
      expect(usersRepo.endCoveringVacationRequests).toHaveBeenCalledWith(
        'u1',
        undefined,
      );
      // Org-wide goes through the AUTHORITATIVE writer, never the plain
      // profile update: it must also clear per-group overrides.
      expect(usersRepo.setVacationModeOrgWide).toHaveBeenCalledWith('u1', false);
      expect(usersRepo.update).not.toHaveBeenCalled();
      expect(usersRepo.setMemberVacationMode).not.toHaveBeenCalled();
    });

    it('with groupId → ends only THAT group’s requests', async () => {
      const { service, usersRepo } = build();
      await service.setVacationMode(
        'u1',
        false,
        { id: 'u1', organizationId: 'org1' },
        undefined,
        'grp_A',
      );
      expect(usersRepo.endCoveringVacationRequests).toHaveBeenCalledWith(
        'u1',
        'grp_A',
      );
    });

    it('with groupId → the USER flag is NOT cleared (it still serves other groups)', async () => {
      const { service, usersRepo } = build();
      await service.setVacationMode(
        'u1',
        false,
        { id: 'u1', organizationId: 'org1' },
        undefined,
        'grp_A',
      );
      // Clearing the shared bit here would re-create the cross-group spill.
      expect(usersRepo.update).not.toHaveBeenCalled();
      expect(usersRepo.setMemberVacationMode).toHaveBeenCalledWith(
        'u1',
        'grp_A',
        'org1',
        false,
      );
    });

    it('the approval gate is scoped to the SAME group as the write', async () => {
      // A group that does not require approval must not inherit another
      // group's gate — the same cross-group bleed this scoping removes.
      const { service, usersRepo } = build();
      await service.setVacationMode(
        'u1',
        true,
        { id: 'u1', organizationId: 'org1' },
        undefined,
        'grp_A',
      );
      expect(usersRepo.vacationRequiresApproval).toHaveBeenCalledWith(
        'u1',
        'grp_A',
      );
    });

    it('COMPATIBILITY: without a group the approval gate stays org-wide', async () => {
      const { service, usersRepo } = build();
      await service.setVacationMode('u1', true, {
        id: 'u1',
        organizationId: 'org1',
      });
      expect(usersRepo.vacationRequiresApproval).toHaveBeenCalledWith(
        'u1',
        undefined,
      );
    });

    it('SECURITY: a foreign groupId is rejected before any write', async () => {
      const { service, usersRepo } = build({ membershipFound: false });
      await expect(
        service.setVacationMode(
          'u1',
          false,
          { id: 'u1', organizationId: 'org1' },
          undefined,
          'grp_FOREIGN',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(usersRepo.endCoveringVacationRequests).not.toHaveBeenCalled();
      expect(usersRepo.setMemberVacationMode).not.toHaveBeenCalled();
      expect(usersRepo.update).not.toHaveBeenCalled();
    });

    it('RACE: membership removed BETWEEN the pre-check and the write → rejects, never a false 200', async () => {
      // The pre-check and the write share one where-clause, so they can only
      // disagree when the membership is removed in between. `updateMany`
      // reports that as count 0 instead of throwing, so an unchecked call
      // would answer 200 `{ isVacationMode: false }` having written nothing —
      // and the covering requests are ALREADY ended by that point, leaving the
      // member's vacation destroyed with no flag to show for it.
      const { service, usersRepo } = build();
      usersRepo.findActiveMembershipId.mockResolvedValue('gm_1'); // pre-check passes
      usersRepo.setMemberVacationMode.mockResolvedValue(false); // ...write matches nothing

      await expect(
        service.setVacationMode(
          'u1',
          false,
          { id: 'u1', organizationId: 'org1' },
          undefined,
          'grp_A',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // The user-level flag must NOT be used as a consolation write: that
      // would spill the change into every other group.
      expect(usersRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── ④ The scope field itself ─────────────────────────────────────────────

  describe('groupId validation', () => {
    const check = async (dto: any, raw: object) =>
      validate(plainToInstance(dto, raw) as object, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    for (const [name, dto] of [
      ['VacationModeDto', VacationModeDto],
      ['DefaultAttendanceDto', DefaultAttendanceDto],
    ] as const) {
      it(`${name}: OMITTED groupId stays valid — the org-wide compatibility path`, async () => {
        expect(await check(dto, { enabled: true })).toHaveLength(0);
      });

      it(`${name}: a real groupId is accepted`, async () => {
        expect(
          await check(dto, { enabled: true, groupId: 'grp_A' }),
        ).toHaveLength(0);
      });

      it(`${name}: an EMPTY groupId is REJECTED, not silently org-wide`, async () => {
        // '' is falsy, so without @IsNotEmpty the service's `if (groupId)`
        // would fall through to the user-level write and change EVERY group
        // the member belongs to — silently, while the client believed it had
        // scoped the request to one.
        const errors = await check(dto, { enabled: true, groupId: '' });
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('groupId');
      });
    }
  });
});
