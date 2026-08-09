#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# billing-gate.sh — Meal Pricing is the MASTER GATE for Meal Billing.
#
#   • LT15B-010 a pricing-OFF group REJECTS the billing summary with
#               400 BILLING_NOT_APPLICABLE (not a misleading ₹0 payload)
#   • LT15B-011 a pricing-ON group still returns its summary (no regression)
#   • LT15B-012 a member's own billing obeys the same gate
#   • LT15B-014 billing ANALYTICS (billing-series) obeys the same gate
#   • LT15B-015 the DEDICATED billing export is gated
#   • LT15B-016 the ATTENDANCE export is NOT gated — it stays available and
#               simply drops its ₹ columns (feature-preservation guard)
#   • LT15B-013 (WRITE-gated) a pricing-OFF group REJECTS a billing-cycle
#               change with BILLING_CYCLE_NOT_APPLICABLE
#
# PROD-SAFE: READ-ONLY by default. Behind WRITE_TESTS=1 it sends ONE
# deliberately-invalid PATCH whose EXPECTED outcome is REJECTION — nothing is
# written, so there is nothing to clean up. Touches no application code and no
# infrastructure. Standalone-runnable (`bash deploy/srs/billing-gate.sh`) or
# sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (billing-gate)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

req GET /groups "" "$ADMIN_TOKEN"
GROUPS_JSON="$R_BODY"

echo
echo "── Live-Test-15 · ISSUE-2/3 — Meal Pricing gates Meal Billing ───────────"

# Split the visible groups by their EFFECTIVE billing applicability.
PRICED="$(printf '%s' "$GROUPS_JSON" | jq -r '
  (.data // .)[]? | select(.mealConfig.mealsEnabled == true and .mealConfig.mealPricingEnabled == true) | .id' 2>/dev/null | head -1)"
UNPRICED="$(printf '%s' "$GROUPS_JSON" | jq -r '
  (.data // .)[]? | select(.mealConfig.mealsEnabled != true or .mealConfig.mealPricingEnabled != true) | .id' 2>/dev/null | head -1)"

# LT15B-010 — pricing OFF ⇒ the billing feature does not exist for the group.
if [ -z "$UNPRICED" ]; then
  skip "LT15B-010 pricing-OFF group rejects billing summary" "(no unpriced group)" "LT15B-010"
else
  req GET "/attendance/billing-summary?groupId=$UNPRICED" "" "$ADMIN_TOKEN"
  CODE="$(printf '%s' "$R_BODY" | jq -r '.code // .error.code // empty' 2>/dev/null)"
  if [ "$R_CODE" = "400" ] && [ "$CODE" = "BILLING_NOT_APPLICABLE" ]; then
    ok "LT15B-010 pricing-OFF group rejects billing summary" "(400 $CODE)" "LT15B-010"
  else
    no "LT15B-010 pricing-OFF group rejects billing summary" "HTTP $R_CODE code=${CODE:-none}" "LT15B-010"
  fi
fi

# LT15B-011 — pricing ON keeps working EXACTLY as before (regression guard).
if [ -z "$PRICED" ]; then
  skip "LT15B-011 pricing-ON group still returns its summary" "(no priced group)" "LT15B-011"
else
  req GET "/attendance/billing-summary?groupId=$PRICED" "" "$ADMIN_TOKEN"
  [ "$R_CODE" = "200" ] \
    && ok "LT15B-011 pricing-ON group still returns its summary" "(200)" "LT15B-011" \
    || no "LT15B-011 pricing-ON group still returns its summary" "HTTP $R_CODE" "LT15B-011"
fi

# LT15B-012 — the member-facing route obeys the same gate. Uses the STUDENT
# account so the membership 403 path is exercised as a real member would.
if [ -z "${STUDENT_EMAIL:-}" ] || [ -z "${STUDENT_PASS:-}" ]; then
  skip "LT15B-012 my-billing obeys the pricing gate" "(no student account)" "LT15B-012"
else
  reuse_or_login STUDENT_TOKEN "$STUDENT_EMAIL" "$STUDENT_PASS"
  if [ -z "$STUDENT_TOKEN" ]; then
    skip "LT15B-012 my-billing obeys the pricing gate" "(student login failed)" "LT15B-012"
  else
    req GET /groups "" "$STUDENT_TOKEN"
    SG="$(printf '%s' "$R_BODY" | jq -r '(.data // .)[0]?.id // empty' 2>/dev/null)"
    SG_PRICED="$(printf '%s' "$R_BODY" | jq -r '
      (.data // .)[0]? | (.mealConfig.mealsEnabled == true and .mealConfig.mealPricingEnabled == true)' 2>/dev/null)"
    if [ -z "$SG" ]; then
      skip "LT15B-012 my-billing obeys the pricing gate" "(student has no group)" "LT15B-012"
    else
      req GET "/attendance/my-billing?groupId=$SG" "" "$STUDENT_TOKEN"
      CODE="$(printf '%s' "$R_BODY" | jq -r '.code // .error.code // empty' 2>/dev/null)"
      if [ "$SG_PRICED" = "true" ]; then
        [ "$R_CODE" = "200" ] \
          && ok "LT15B-012 my-billing obeys the pricing gate" "(priced → 200)" "LT15B-012" \
          || no "LT15B-012 my-billing obeys the pricing gate" "priced but HTTP $R_CODE" "LT15B-012"
      else
        if [ "$R_CODE" = "400" ] && [ "$CODE" = "BILLING_NOT_APPLICABLE" ]; then
          ok "LT15B-012 my-billing obeys the pricing gate" "(unpriced → 400)" "LT15B-012"
        else
          no "LT15B-012 my-billing obeys the pricing gate" "HTTP $R_CODE code=${CODE:-none}" "LT15B-012"
        fi
      fi
    fi
  fi
fi

# LT15B-014 — billing ANALYTICS obeys the same gate (it is part of the
# financial subsystem, so a pricing-OFF group must not get a ₹ time-series).
if [ -z "$UNPRICED" ]; then
  skip "LT15B-014 pricing-OFF rejects billing analytics" "(no unpriced group)" "LT15B-014"
else
  req GET "/attendance/billing-series?groupId=$UNPRICED" "" "$ADMIN_TOKEN"
  CODE="$(printf '%s' "$R_BODY" | jq -r '.code // .error.code // empty' 2>/dev/null)"
  if [ "$R_CODE" = "400" ] && [ "$CODE" = "BILLING_NOT_APPLICABLE" ]; then
    ok "LT15B-014 pricing-OFF rejects billing analytics" "(400 $CODE)" "LT15B-014"
  else
    no "LT15B-014 pricing-OFF rejects billing analytics" "HTTP $R_CODE code=${CODE:-none}" "LT15B-014"
  fi
fi

# LT15B-015 — the DEDICATED billing export is billing-specific and gated; the
# ATTENDANCE export is NOT (it stays available and just drops its ₹ columns).
if [ -z "$UNPRICED" ]; then
  skip "LT15B-015 pricing-OFF rejects the billing export" "(no unpriced group)" "LT15B-015"
else
  TODAY="$(date +%F)"
  req GET "/exports/billing?groupId=$UNPRICED&fromDate=$TODAY&toDate=$TODAY" "" "$ADMIN_TOKEN"
  CODE="$(printf '%s' "$R_BODY" | jq -r '.code // .error.code // empty' 2>/dev/null)"
  if [ "$R_CODE" = "400" ] && [ "$CODE" = "BILLING_NOT_APPLICABLE" ]; then
    ok "LT15B-015 pricing-OFF rejects the billing export" "(400 $CODE)" "LT15B-015"
  else
    no "LT15B-015 pricing-OFF rejects the billing export" "HTTP $R_CODE code=${CODE:-none}" "LT15B-015"
  fi

  req GET "/exports/attendance?groupId=$UNPRICED&fromDate=$TODAY&toDate=$TODAY" "" "$ADMIN_TOKEN"
  if [ "$R_CODE" = "200" ]; then
    ok "LT15B-016 attendance export still works when pricing is OFF" "(200)" "LT15B-016"
  else
    no "LT15B-016 attendance export still works when pricing is OFF" "HTTP $R_CODE" "LT15B-016"
  fi
fi

# LT15B-013 — WRITE-gated, REJECTION-ONLY: a pricing-OFF group must refuse a
# billing-cycle change. The expected outcome is a 4xx, so nothing is persisted
# and there is nothing to clean up.
if [ "${WRITE_TESTS:-0}" != "1" ]; then
  skip "LT15B-013 pricing-OFF rejects a billing-cycle change" "(needs --writes)" "LT15B-013"
elif [ -z "$UNPRICED" ]; then
  skip "LT15B-013 pricing-OFF rejects a billing-cycle change" "(no unpriced group)" "LT15B-013"
else
  req PATCH "/groups/$UNPRICED" '{"mealConfig":{"billingCycleStartDay":7}}' "$ADMIN_TOKEN"
  CODE="$(printf '%s' "$R_BODY" | jq -r '.code // .error.code // empty' 2>/dev/null)"
  if [ "$R_CODE" = "400" ] && [ "$CODE" = "BILLING_CYCLE_NOT_APPLICABLE" ]; then
    ok "LT15B-013 pricing-OFF rejects a billing-cycle change" "(400 $CODE)" "LT15B-013"
  else
    no "LT15B-013 pricing-OFF rejects a billing-cycle change" "HTTP $R_CODE code=${CODE:-none}" "LT15B-013"
  fi
fi

# Device-only attestations — UI visibility cannot be probed over HTTP.
tag "LT15B-020" MANUAL "pricing OFF hides: Member Billing quick action, Student Billing card, Profile My Billing, Billing Cycle tile — verify on device"
tag "LT15B-021" MANUAL "pricing OFF still shows meals/attendance normally (Meal Pricing OFF is NOT Meal System OFF) — verify on device"
MANUAL=$((MANUAL+2))

[ "${SRS_SOURCED:-0}" = "1" ] || summary "MEAL-PRICING BILLING GATE"
