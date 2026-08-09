import {
  isBillingApplicable,
  assertBillingApplicable,
} from './billing-applicability.util';

/**
 * Live-Test-15 ISSUE-2/3 (user-approved) — MEAL PRICING IS THE MASTER GATE.
 *
 * Locks the truth table so no future change can quietly re-expose meal billing
 * to a group that has no financial subsystem.
 */
describe('billing applicability (Meal Pricing master gate)', () => {
  const cases: Array<[string, any, boolean]> = [
    ['Attendance-Only', { mealsEnabled: false, mealPricingEnabled: false }, false],
    [
      'Attendance-Only with a stale pricing flag',
      { mealsEnabled: false, mealPricingEnabled: true },
      false,
    ],
    ['Meals ON + Pricing OFF', { mealsEnabled: true, mealPricingEnabled: false }, false],
    ['Meals ON + Pricing ON', { mealsEnabled: true, mealPricingEnabled: true }, true],
    ['legacy row with undefined flags', {}, false],
    ['missing group', null, false],
  ];

  for (const [label, group, expected] of cases) {
    it(`${label} → billing ${expected ? 'APPLIES' : 'does NOT apply'}`, () => {
      expect(isBillingApplicable(group)).toBe(expected);
    });
  }

  it('assert passes silently for a billable group', () => {
    expect(() =>
      assertBillingApplicable({ mealsEnabled: true, mealPricingEnabled: true }),
    ).not.toThrow();
  });

  it('assert rejects a pricing-OFF group with BILLING_NOT_APPLICABLE (400)', () => {
    let caught: any;
    try {
      assertBillingApplicable(
        { mealsEnabled: true, mealPricingEnabled: false },
        'g1',
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.getStatus()).toBe(400);
    expect(caught.getResponse()).toMatchObject({
      code: 'BILLING_NOT_APPLICABLE',
    });
    // The message must name the ACTUAL reason so the client can explain it.
    expect(caught.getResponse().message).toContain('Meal Pricing is disabled');
  });

  it('assert distinguishes Attendance-Only from pricing-OFF in its message', () => {
    let caught: any;
    try {
      assertBillingApplicable({ mealsEnabled: false, mealPricingEnabled: false });
    } catch (e) {
      caught = e;
    }
    expect(caught.getResponse().message).toContain('Attendance-Only');
  });
});
