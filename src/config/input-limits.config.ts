/**
 * Live-Test-16 — user-locked input ceilings that validation DECORATORS need.
 *
 * class-validator decorators (@MaxLength / @Max) are evaluated when a DTO
 * module is first imported, before any ConfigService instance exists, so
 * these are plain env-overridable constants (same `intOr` rule as
 * groups.config.ts) instead of `registerAs` values. The defaults ARE the
 * locked business values; an env override only exists as an ops lever.
 */
const intOr = (v: string | undefined, d: number): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const INPUT_LIMITS = {
  /** ISSUE-1: billing-adjustment audit-trail reason (characters). */
  adjustmentReasonMaxLength: intOr(
    process.env.ADJUSTMENT_REASON_MAX_LENGTH,
    30,
  ),
  /** ISSUE-4: hard ceiling on guests a member may host per meal. */
  guestMaxPerMeal: intOr(process.env.GUEST_MAX_PER_MEAL, 5),
} as const;
