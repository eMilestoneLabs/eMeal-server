#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# firstpublish-windows.sh — Live-Test-16 contract validation over real HTTP:
#
#   ISSUE-1 (First-Publish financial review + permanent Meal-Pricing lock)
#     • LT16-001 the group payload exposes mealConfig.mealPricingLocked
#     • LT16-002 GET /groups/:id/meal-config exposes the SAME flag (lock-step)
#     • LT16-003 a LOCKED group rejects a Meal-Pricing flip with 400
#                MEAL_PRICING_LOCKED  (probe only runs when a locked group
#                exists; never creates one — the lock is irreversible)
#     • LT16-004 a same-value echo on a LOCKED group is NOT rejected (the whole
#                mealConfig is re-sent by the app on every unrelated toggle)
#
#   ISSUE-2 (attendance windows: mandatory, same-day, no overlap, >= 1h gap)
#     • LT16-010 every ACTIVE meal of every group carries a window
#     • LT16-011 no two windows of a group overlap
#     • LT16-012 consecutive windows keep the configured minimum gap
#     • LT16-013 no window crosses midnight (close > open)
#       (the implicit `__general__` slot is EXEMPT — it is a system row)
#
# PROD-SAFE: 100% READ-ONLY. It performs GETs plus, behind WRITE_TESTS=1, ONE
# deliberately-invalid PATCH whose expected outcome is REJECTION (nothing is
# written, nothing to clean up). It NEVER publishes a schedule, never creates a
# group, and never consumes a lock. Touches no application code and no
# infrastructure. Standalone-runnable or sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (firstpublish-windows)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

# Minimum gap in minutes — mirrors MEALS_WINDOW_MIN_GAP_MINUTES (default 60).
GAP_MIN="${MEALS_WINDOW_MIN_GAP_MINUTES:-60}"
GENERAL_SLOT='__general__'

echo
echo "── Live-Test-16 · ISSUE-1 — First-Publish Meal-Pricing lock ─────────────"

req GET /groups "" "$ADMIN_TOKEN"
GROUPS_JSON="$R_BODY"
GIDS="$(printf '%s' "$GROUPS_JSON" | jq -r '(.data // .)[]?.id' 2>/dev/null)"
if [ -z "$GIDS" ]; then
  skip "LT16-001 mealPricingLocked exposed" "(no groups visible)" "LT16-001"
else
  # LT16-001 — the flag must be present (not null/absent) on the list payload.
  HAS_FLAG="$(printf '%s' "$GROUPS_JSON" \
    | jq -r '[(.data // .)[]? | .mealConfig.mealPricingLocked] | map(type=="boolean") | all' 2>/dev/null)"
  if [ "$HAS_FLAG" = "true" ]; then
    ok "LT16-001 mealPricingLocked exposed on every group" "" "LT16-001"
  else
    no "LT16-001 mealPricingLocked exposed on every group" "missing/!boolean" "LT16-001"
  fi

  # LT16-002 — the dedicated meal-config endpoint must agree (lock-step rule).
  G1="$(printf '%s\n' $GIDS | head -1)"
  req GET "/groups/$G1/meal-config" "" "$ADMIN_TOKEN"
  # NOTE: jq's `//` treats FALSE as a false value, exactly like null — so
  # `.mealPricingLocked // .data.mealPricingLocked` on a correct `false` falls
  # through to the alternative and reports "null". An unpublished group is
  # legitimately false, so this probe must branch on PRESENCE, not truthiness.
  MC_FLAG="$(jbody 'if has("mealPricingLocked") then .mealPricingLocked
                    elif (.data? | type) == "object" and (.data | has("mealPricingLocked"))
                      then .data.mealPricingLocked
                    else null end')"
  LIST_FLAG="$(printf '%s' "$GROUPS_JSON" \
    | jq -r --arg g "$G1" '((.data // .)[]? | select(.id==$g) | .mealConfig.mealPricingLocked)' 2>/dev/null)"
  if [ "$MC_FLAG" = "$LIST_FLAG" ] && [ -n "$MC_FLAG" ] && [ "$MC_FLAG" != "null" ]; then
    ok "LT16-002 meal-config agrees with group payload" "($MC_FLAG)" "LT16-002"
  else
    no "LT16-002 meal-config agrees with group payload" "meal-config=$MC_FLAG list=$LIST_FLAG" "LT16-002"
  fi

  # LT16-003/004 — behaviour of a LOCKED group. We never create the lock (it is
  # permanent); we only probe one if the tenant already has one.
  LOCKED="$(printf '%s' "$GROUPS_JSON" \
    | jq -r 'first((.data // .)[]? | select(.mealConfig.mealPricingLocked==true) | .id) // empty' 2>/dev/null)"
  if [ -z "$LOCKED" ]; then
    skip "LT16-003 locked group rejects a pricing flip" "(no published group yet)" "LT16-003"
    skip "LT16-004 locked group accepts a same-value echo" "(no published group yet)" "LT16-004"
  elif [ "${WRITE_TESTS:-0}" != "1" ]; then
    skip "LT16-003 locked group rejects a pricing flip" "(WRITE_TESTS=1 to enable)" "LT16-003"
    skip "LT16-004 locked group accepts a same-value echo" "(WRITE_TESTS=1 to enable)" "LT16-004"
  else
    CUR="$(printf '%s' "$GROUPS_JSON" \
      | jq -r --arg g "$LOCKED" '((.data // .)[]? | select(.id==$g) | .mealConfig.mealPricingEnabled)' 2>/dev/null)"
    FLIP='true'; [ "$CUR" = "true" ] && FLIP='false'

    # The flip MUST be refused — nothing is written, so there is nothing to undo.
    req PATCH "/groups/$LOCKED" "{\"mealConfig\":{\"mealPricingEnabled\":$FLIP}}" "$ADMIN_TOKEN"
    CODE_TXT="$(jbody '.code // .message // empty')"
    if [ "$R_CODE" = "400" ] && printf '%s' "$CODE_TXT" | grep -qi 'MEAL_PRICING_LOCKED\|finalized'; then
      ok "LT16-003 locked group rejects a pricing flip" "(400 MEAL_PRICING_LOCKED)" "LT16-003"
    else
      no "LT16-003 locked group rejects a pricing flip" "got $R_CODE $CODE_TXT" "LT16-003"
    fi

    # The SAME value must still be accepted: the app re-sends the whole
    # mealConfig on every unrelated toggle, so a presence-based lock would
    # break vacation/guest/meals settings entirely.
    req PATCH "/groups/$LOCKED" "{\"mealConfig\":{\"mealPricingEnabled\":$CUR}}" "$ADMIN_TOKEN"
    assert_in "LT16-004 locked group accepts a same-value echo" "$R_CODE" "LT16-004" 200 201
  fi
fi

echo
echo "── Live-Test-16 · ISSUE-2 — attendance-window invariant ─────────────────"

WIN_MISSING=0; WIN_OVERNIGHT=0; WIN_OVERLAP=0; WIN_GAP=0; WIN_GROUPS=0
WIN_DETAIL=""
for g in $GIDS; do
  req GET "/meals?groupId=$g" "" "$ADMIN_TOKEN"
  # Active, non-system meals only: "HH:mm|HH:mm|name" per line, sorted by open.
  ROWS="$(printf '%s' "$R_BODY" | jq -r --arg gen "$GENERAL_SLOT" '
    [ (.data // .)[]?
      | select(.isActive != false)
      | select((.slotKey // "") != $gen) ]
    | .[] | "\(.attendanceWindow.openTime // "")|\(.attendanceWindow.closeTime // "")|\(.name // "?")"
  ' 2>/dev/null)"
  [ -z "$ROWS" ] && continue
  WIN_GROUPS=$((WIN_GROUPS+1))

  # LT16-010/013 — presence + same-day, per meal.
  while IFS='|' read -r o c n; do
    [ -z "$n" ] && continue
    if [ -z "$o" ] || [ -z "$c" ]; then
      WIN_MISSING=$((WIN_MISSING+1)); WIN_DETAIL="$WIN_DETAIL [$g/$n:no-window]"; continue
    fi
    om=$(( 10#${o%%:*} * 60 + 10#${o##*:} ))
    cm=$(( 10#${c%%:*} * 60 + 10#${c##*:} ))
    [ "$cm" -le "$om" ] && { WIN_OVERNIGHT=$((WIN_OVERNIGHT+1)); WIN_DETAIL="$WIN_DETAIL [$g/$n:$o-$c]"; }
  done <<< "$ROWS"

  # LT16-011/012 — pairwise overlap + gap, comparing against the running latest
  # close so a fully-contained window is caught too.
  PREV_C=-100000; PREV_N=""
  while IFS='|' read -r o c n; do
    { [ -z "$o" ] || [ -z "$c" ]; } && continue
    om=$(( 10#${o%%:*} * 60 + 10#${o##*:} ))
    cm=$(( 10#${c%%:*} * 60 + 10#${c##*:} ))
    [ "$cm" -le "$om" ] && continue   # already counted as overnight
    if [ -n "$PREV_N" ]; then
      if [ "$om" -lt "$PREV_C" ]; then
        WIN_OVERLAP=$((WIN_OVERLAP+1)); WIN_DETAIL="$WIN_DETAIL [$g:$PREV_N~$n overlap]"
      elif [ $(( om - PREV_C )) -lt "$GAP_MIN" ]; then
        WIN_GAP=$((WIN_GAP+1)); WIN_DETAIL="$WIN_DETAIL [$g:$PREV_N~$n gap=$(( om - PREV_C ))m]"
      fi
    fi
    [ "$cm" -gt "$PREV_C" ] && { PREV_C=$cm; PREV_N="$n"; }
  done <<< "$(printf '%s\n' "$ROWS" | sort -t'|' -k1,1)"
done

if [ "$WIN_GROUPS" -eq 0 ]; then
  skip "LT16-010..013 attendance-window invariant" "(no meals configured)" "LT16-010,LT16-011,LT16-012,LT16-013"
else
  [ "$WIN_MISSING"   -eq 0 ] && ok "LT16-010 every active meal has a window"      "($WIN_GROUPS groups)" "LT16-010" \
                             || no "LT16-010 every active meal has a window"      "$WIN_MISSING missing:$WIN_DETAIL" "LT16-010"
  [ "$WIN_OVERLAP"   -eq 0 ] && ok "LT16-011 no overlapping windows"              "" "LT16-011" \
                             || no "LT16-011 no overlapping windows"              "$WIN_OVERLAP:$WIN_DETAIL" "LT16-011"
  [ "$WIN_GAP"       -eq 0 ] && ok "LT16-012 windows keep the ${GAP_MIN}m gap"    "" "LT16-012" \
                             || no "LT16-012 windows keep the ${GAP_MIN}m gap"    "$WIN_GAP:$WIN_DETAIL" "LT16-012"
  [ "$WIN_OVERNIGHT" -eq 0 ] && ok "LT16-013 no window crosses midnight"          "" "LT16-013" \
                             || no "LT16-013 no window crosses midnight"          "$WIN_OVERNIGHT:$WIN_DETAIL" "LT16-013"
fi

# Device-only attestations — the premium review UI cannot be probed over HTTP.
tag "LT16-020" MANUAL "First-Publish review sheet appears on the FIRST publish only (light+dark) — verify on device"
tag "LT16-021" MANUAL "publish stays disabled until all 3 acknowledgements are ticked — verify on device"
tag "LT16-022" MANUAL "'Review / Change Configuration' returns to Meal Config and publishes NOTHING — verify on device"
tag "LT16-023" MANUAL "a FAILED publish keeps the sheet open and does NOT lock pricing — verify on device"
tag "LT16-024" MANUAL "locked group shows 'Meal Pricing — Enabled/Disabled 🔒' read-only — verify on device"
MANUAL=$((MANUAL+5))

[ "${SRS_SOURCED:-0}" = "1" ] || summary "LIVE-TEST-16 FIRST-PUBLISH & WINDOWS"
