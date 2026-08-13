/**
 * GroupMemberSerializer — the roster response is GROUP-scoped, so the vacation
 * badge it carries must be too.
 *
 * The member list is rendered per group, but `isVacationMode` used to be read
 * straight off the joined user row — a single flag shared by every group the
 * member belongs to. An admin looking at group B would then see a member badged
 * "on vacation" purely because that member is on vacation in group A.
 *
 * The response SHAPE is unchanged (same key, same type, no extra field): only
 * the value is now resolved per group, from the membership row the list query
 * already returns.
 */
import { GroupMemberSerializer } from '../serializers/group-member.serializer';
import { GroupMemberEntity } from '../entities/group-member.entity';

const member = (over: Partial<GroupMemberEntity> = {}) =>
  new GroupMemberEntity({
    id: 'gm_01',
    groupId: 'grp_01',
    userId: 'usr_01',
    role: 'member',
    status: 'active',
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    user: {
      id: 'usr_01',
      name: 'Riya',
      email: 'riya@example.com',
      phone: null,
      avatarUrl: null,
      gender: null,
      age: null,
      role: 'student',
      isVacationMode: false,
    },
    ...over,
  });

describe('GroupMemberSerializer — group-scoped vacation badge', () => {
  // POST A-FULL SEMANTICS (2026-08-12). This input used to be the cross-group
  // leak: the read-time sync and the FR-VACX-006 sweep set the ACCOUNT flag
  // from ANY covering request, so a member on group-A leave reached here with
  // override=NULL + userFlag=true and was badged in group B. A-full removed
  // that at the SOURCE — a group-scoped request now writes its own membership,
  // and only an ORG-LEVEL request (or a deliberate org-wide toggle) raises the
  // account flag. So `userFlag=true` with no override now means an ORG-WIDE
  // vacation, which SHOULD badge in every group. The serializer's
  // `member ?? user` rule is correct and deliberately unchanged; what changed
  // is which states can occur.
  it('inherits the user flag when this group has no override (baseline)', () => {
    const res: any = GroupMemberSerializer.toResponse(
      member({
        isVacationMode: null,
        user: { ...member().user!, isVacationMode: true },
      }),
    );
    expect(res.user.isVacationMode).toBe(true);
  });

  it('inherits an OFF user flag when this group has no override (baseline)', () => {
    const res: any = GroupMemberSerializer.toResponse(
      member({ isVacationMode: null }),
    );
    expect(res.user.isVacationMode).toBe(false);
  });

  // Renamed 2026-08-12: this asserts `??` semantics, NOT the cross-group leak.
  // It sets the override to an explicit FALSE, which is not how the leak
  // presents — under the leak nobody has written the column at all, so it is
  // NULL. The old name claimed coverage this never had.
  it('an explicit per-group FALSE wins over an inherited TRUE', () => {
    const res: any = GroupMemberSerializer.toResponse(
      member({
        isVacationMode: false,
        user: { ...member().user!, isVacationMode: true },
      }),
    );
    expect(res.user.isVacationMode).toBe(false);
  });

  it('badges a member on vacation in THIS group even when the user flag is off', () => {
    const res: any = GroupMemberSerializer.toResponse(
      member({ isVacationMode: true }),
    );
    expect(res.user.isVacationMode).toBe(true);
  });

  // Shape guard: this is an additive-safe serializer, so the fix must not have
  // added, renamed or dropped a key — only changed which value fills one.
  it('keeps the response shape unchanged (same keys, boolean badge)', () => {
    const res: any = GroupMemberSerializer.toResponse(member());
    expect(Object.keys(res)).toEqual([
      'id', 'groupId', 'userId', 'role', 'functionalRole', 'status',
      'joinedAt', 'updatedAt', 'blockedAt', 'blockedBy', 'removedAt', 'user',
    ]);
    expect(typeof res.user.isVacationMode).toBe('boolean');
    // The per-group columns themselves stay OUT of the response: the roster
    // contract is an explicit allow-list, not a row dump.
    expect(res).not.toHaveProperty('isVacationMode');
    expect(res).not.toHaveProperty('isDefaultAttendance');
  });
});
