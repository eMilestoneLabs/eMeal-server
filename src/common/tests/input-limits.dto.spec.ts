import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAdjustmentDto } from '../../features/billing/dto/billing-adjustment.dto';
import { GuestConfigDto } from '../../features/groups/dto/create-group.dto';

/**
 * Live-Test-16 ISSUE-1 (audit-trail reason ≤ 30) and ISSUE-4 (≤ 5 guests
 * per meal; adult/child pricing mode retired) — enforced SERVER-side, so a
 * direct API call cannot bypass the app's input limits.
 */
const errorsOf = async (cls: any, raw: object) =>
  validate(plainToInstance(cls, raw) as object);

describe('Live-Test-16 input limits (DTO)', () => {
  const adj = (reason: string) => ({
    groupId: 'g1',
    userId: 'u1',
    type: 'credit',
    amount: 100,
    reason,
  });

  it('reason of exactly 30 characters is accepted', async () => {
    expect(await errorsOf(CreateAdjustmentDto, adj('x'.repeat(30)))).toHaveLength(0);
  });

  it('reason of 31 characters is rejected', async () => {
    const errs = await errorsOf(CreateAdjustmentDto, adj('x'.repeat(31)));
    expect(errs.map((e) => e.property)).toContain('reason');
  });

  it('reason is trimmed before the length check', async () => {
    expect(await errorsOf(CreateAdjustmentDto, adj(`  ${'x'.repeat(30)}  `))).toHaveLength(0);
  });

  it('5 guests per meal is accepted, 6 is rejected', async () => {
    expect(await errorsOf(GuestConfigDto, { maxGuestsPerMemberPerMeal: 5 })).toHaveLength(0);
    const errs = await errorsOf(GuestConfigDto, { maxGuestsPerMemberPerMeal: 6 });
    expect(errs.map((e) => e.property)).toContain('maxGuestsPerMemberPerMeal');
  });

  it('pricing modes: sameAsMember + flatSurcharge accepted, perGuestPrice rejected', async () => {
    expect(await errorsOf(GuestConfigDto, { guestPricingMode: 'sameAsMember' })).toHaveLength(0);
    expect(await errorsOf(GuestConfigDto, { guestPricingMode: 'flatSurcharge' })).toHaveLength(0);
    const errs = await errorsOf(GuestConfigDto, { guestPricingMode: 'perGuestPrice' });
    expect(errs.map((e) => e.property)).toContain('guestPricingMode');
  });
});
