import { BadRequestException } from '@nestjs/common';

/**
 * billing-applicability.util.ts — Live-Test-15 ISSUE-2/3 (user-approved).
 *
 * SINGLE SOURCE OF TRUTH for "does this group have a financial meal-billing
 * subsystem at all?".
 *
 * THE RULE
 *   Meal Pricing is the MASTER FEATURE GATE for meal billing.
 *     • Attendance-Only            → no billing.
 *     • Meals ON  + Pricing OFF    → no billing (meals/attendance keep working).
 *     • Meals ON  + Pricing ON     → billing applies.
 *
 * Returning a ₹0 summary for a non-billing group is exactly what the
 * requirement rejects: the feature must not exist for that group, not merely
 * render as zero. The frontend hides every billing surface; this is the
 * independent backend enforcement, so the rule survives a stale client, a
 * cached screen, another device or a direct API call.
 *
 * SCOPE: only the FINANCIAL subsystem. Meals, attendance, preferences,
 * vacation, corrections, non-financial reports and the published-schedule
 * architecture are untouched by this gate.
 *
 * Lives in `common/utils` (not on a service) so both `AttendanceService` (the
 * billing reads) and `BillingService` (periods / adjustments) share one
 * implementation — `AttendanceService` already depends on `BillingService`, so
 * a static on either one would have made the two circular.
 */

/** The minimal group shape this rule needs. Both flags ride existing selects. */
export interface BillingApplicabilityGroup {
  mealsEnabled?: boolean | null;
  mealPricingEnabled?: boolean | null;
}

/** True when the group has a financial meal-billing subsystem. */
export function isBillingApplicable(
  group: BillingApplicabilityGroup | null | undefined,
): boolean {
  return group?.mealsEnabled === true && group?.mealPricingEnabled === true;
}

/**
 * Throws `BILLING_NOT_APPLICABLE` (400) unless the group has meal billing.
 *
 * Deliberately mirrors the existing `BILLING_CYCLE_NOT_APPLICABLE` contract in
 * `GroupsService.updateGroup` — same status, same error shape — so clients
 * handle one consistent error family.
 */
export function assertBillingApplicable(
  group: BillingApplicabilityGroup | null | undefined,
  groupId?: string,
): void {
  if (isBillingApplicable(group)) return;
  throw new BadRequestException({
    message:
      group?.mealsEnabled === true
        ? 'Meal Pricing is disabled for this group, so it has no billing.'
        : 'Attendance-Only groups have no billing.',
    code: 'BILLING_NOT_APPLICABLE',
    errors: {
      groupId:
        'Meal billing applies only to groups with the meal system and Meal Pricing enabled',
      ...(groupId ? { value: groupId } : {}),
    },
  });
}
