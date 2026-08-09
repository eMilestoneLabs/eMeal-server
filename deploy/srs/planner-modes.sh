#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# planner-modes.sh — Weekly ⇆ Day-Wise planner-mode contracts over real HTTP.
#
#   • LT15P-001 both mode flags are exposed on the group payload
#   • LT15P-002 the modes are MUTUALLY EXCLUSIVE while meals are ON
#               (never both true, never both false)
#   • LT15P-003 GET /groups/:id/meal-config agrees with the list payload
#               (lock-step — the planner route is chosen from these flags, so a
#               disagreement sends "Schedule" to the wrong planner)
#   • LT15P-004 the planner read is reachable for the group's ACTIVE mode
#
# PROD-SAFE: 100% READ-ONLY — GETs only. Never creates a group, never changes a
# planner mode, never publishes, never consumes the first-publish lock. Touches
# no application code and no infrastructure. Standalone-runnable
# (`bash deploy/srs/planner-modes.sh`) or sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (planner-modes)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

req GET /groups "" "$ADMIN_TOKEN"
GROUPS_JSON="$R_BODY"
GIDS="$(printf '%s' "$GROUPS_JSON" | jq -r '(.data // .)[]?.id' 2>/dev/null)"

echo
echo "── Live-Test-15 · ISSUE-1 — Weekly ⇆ Day-Wise planner modes ─────────────"

req GET /groups "" "$ADMIN_TOKEN"
GROUPS_JSON="$R_BODY"
GIDS="$(printf '%s' "$GROUPS_JSON" | jq -r '(.data // .)[]?.id' 2>/dev/null)"

if [ -z "$GIDS" ]; then
  skip "LT15P-001 planner mode flags exposed" "(no groups visible)" "LT15P-001"
  skip "LT15P-002 modes mutually exclusive"   "(no groups visible)" "LT15P-002"
else
  # LT15P-001 — both flags present and boolean on EVERY group.
  HAS_FLAGS="$(printf '%s' "$GROUPS_JSON" | jq -r '
    [ (.data // .)[]?
      | (.mealConfig.weeklyMenuEnabled | type == "boolean")
        and (.mealConfig.dayWiseMealsEnabled | type == "boolean") ] | all' 2>/dev/null)"
  [ "$HAS_FLAGS" = "true" ] \
    && ok "LT15P-001 planner mode flags exposed on every group" "" "LT15P-001" \
    || no "LT15P-001 planner mode flags exposed on every group" "missing/!boolean" "LT15P-001"

  # LT15P-002 — exclusivity. While meals are ON exactly one mode is active.
  # (Meals-OFF groups deliberately PRESERVE their stored flags, so they are
  #  exempt: the mode cascade keeps them for re-enable.)
  BAD_MODE="$(printf '%s' "$GROUPS_JSON" | jq -r '
    [ (.data // .)[]?
      | select(.mealConfig.mealsEnabled == true)
      | select((.mealConfig.weeklyMenuEnabled and .mealConfig.dayWiseMealsEnabled)
               or ((.mealConfig.weeklyMenuEnabled | not) and (.mealConfig.dayWiseMealsEnabled | not)))
      | .name ] | join(",")' 2>/dev/null)"
  [ -z "$BAD_MODE" ] \
    && ok "LT15P-002 exactly one planner mode active per meals-ON group" "" "LT15P-002" \
    || no "LT15P-002 exactly one planner mode active per meals-ON group" "$BAD_MODE" "LT15P-002"

  # LT15P-003 — the dedicated meal-config endpoint must agree (lock-step).
  G1="$(printf '%s\n' $GIDS | head -1)"
  LIST_DW="$(printf '%s' "$GROUPS_JSON" \
    | jq -r --arg g "$G1" '((.data // .)[]? | select(.id==$g) | .mealConfig.dayWiseMealsEnabled)' 2>/dev/null)"
  req GET "/groups/$G1/meal-config" "" "$ADMIN_TOKEN"
  CFG_DW="$(printf '%s' "$R_BODY" | jq -r '(.data // .).dayWiseMealsEnabled // .dayWiseMealsEnabled' 2>/dev/null)"
  if [ "$CFG_DW" = "null" ] || [ -z "$CFG_DW" ]; then
    skip "LT15P-003 meal-config agrees on planner mode" "(flag not in payload)" "LT15P-003"
  elif [ "$CFG_DW" = "$LIST_DW" ]; then
    ok "LT15P-003 meal-config agrees on planner mode" "(dayWise=$CFG_DW)" "LT15P-003"
  else
    no "LT15P-003 meal-config agrees on planner mode" "list=$LIST_DW cfg=$CFG_DW" "LT15P-003"
  fi

  # LT15P-004 — the planner read works for the group's ACTIVE mode. Both modes
  # read the same endpoint; what differs is which days the client renders.
  req GET "/meals/weekly-schedule?groupId=$G1" "" "$ADMIN_TOKEN"
  [ "$R_CODE" = "200" ] \
    && ok "LT15P-004 planner read reachable for the active mode" "(200)" "LT15P-004" \
    || no "LT15P-004 planner read reachable for the active mode" "HTTP $R_CODE" "LT15P-004"
fi

echo

# Device-only attestations — planner UI cannot be probed over HTTP.
tag "LT15P-020" MANUAL "Master Meal Template 'Schedule →' opens the ACTIVE mode's planner (Day-Wise shows 'Daily Plan →') — verify on device"
tag "LT15P-021" MANUAL "switching groups INSIDE the planner switches 7-tab ⇆ 2-tab without a navigation crash — verify on device"
tag "LT15P-022" MANUAL "after a mode switch the planner is DRAFT and members still see the PREVIOUS published schedule until Publish — verify on device"
tag "LT15P-023" MANUAL "Day-Wise on a SUNDAY shows Today=Sun / Tomorrow=Mon and publishes Monday's real date — verify on device"
tag "LT15P-024" MANUAL "group switch inside the planner never shows the previous group's matrix — verify on device"
MANUAL=$((MANUAL+5))

[ "${SRS_SOURCED:-0}" = "1" ] || summary "PLANNER MODES (Weekly / Day-Wise)"
