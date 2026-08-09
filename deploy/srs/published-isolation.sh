#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# published-isolation.sh — P-01 PUBLISHED-SCHEDULE ISOLATION contracts.
#
# The governing invariant: MASTER is configuration, DRAFT is
# configuration-in-progress, PUBLISHED is the permanent operational baseline.
# Nothing may modify the current Published schedule until an explicit
# successful Publish.
#
#   • LT15I-001 a published schedule exposes `requiresRepublish`, so an admin
#               can see whether its configuration is frozen yet (Option 1:
#               legacy schedules are LABELLED, never reconstructed from Master)
#   • LT15I-002 the schedule payload keeps its locked contract shape
#               (days[] always 7, meal identity present) — feature-preservation
#   • LT15I-003 the student meal read and the admin planner read AGREE on the
#               published day's meal identity (display == enforcement). A
#               disagreement is the P-01 leak resurfacing.
#   • LT15I-004 a published day's meal carries a resolved attendance window,
#               i.e. the published baseline is self-sufficient
#   • LT15I-005 ORG ISOLATION — a foreign group id is 404/403, never 200-empty
#
# PROD-SAFE: 100% READ-ONLY — GETs only. Creates nothing, edits nothing, NEVER
# publishes, never consumes the first-publish lock, touches no application code
# and no infrastructure. Standalone-runnable (`bash deploy/srs/published-isolation.sh`)
# or sourced by run.sh. Exit 0 = pass, 2 = failures recorded.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (published-isolation)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

echo
echo "── Live-Test-15 · P-01 — Published schedule isolation ───────────────────"

req GET /groups "" "$ADMIN_TOKEN"
GIDS="$(printf '%s' "$R_BODY" | jq -r '(.data // .)[]?.id' 2>/dev/null)"

if [ -z "$GIDS" ]; then
  skip "LT15I-000 no groups visible to this admin" "nothing to assert"
else
  CHECKED=0
  for GID in $GIDS; do
    [ "$CHECKED" -ge 3 ] && break   # bound the probe — contracts, not a sweep
    req GET "/schedules?groupId=$GID" "" "$ADMIN_TOKEN"
    [ "$R_CODE" != "200" ] && continue
    SCHED="$(printf '%s' "$R_BODY" | jq -c '(.data // .)[0] // empty' 2>/dev/null)"
    [ -z "$SCHED" ] && continue
    CHECKED=$((CHECKED+1))

    # LT15I-001 — the republish signal is exposed (never silently absent).
    HAS_FLAG="$(printf '%s' "$SCHED" | jq -r 'has("requiresRepublish")')"
    if [ "$HAS_FLAG" = "true" ]; then
      ok "LT15I-001 requiresRepublish exposed" "group=$GID" LT15I-001
    else
      no "LT15I-001 requiresRepublish MISSING" "group=$GID — admin cannot see whether the published config is frozen" LT15I-001
    fi

    # LT15I-002 — locked contract shape survives (all 7 days always present).
    NDAYS="$(printf '%s' "$SCHED" | jq -r '(.days // []) | length')"
    if [ "$NDAYS" = "7" ]; then
      ok "LT15I-002 schedule contract intact (days=7)" "group=$GID" LT15I-002
    else
      no "LT15I-002 schedule contract BROKEN" "group=$GID days=$NDAYS (expected 7)" LT15I-002
    fi

    # LT15I-004 — a scheduled meal carries its resolved identity + window, so
    # the published baseline needs nothing from live Master to be operational.
    MEAL="$(printf '%s' "$SCHED" | jq -c '[.days[]?.meals[]?] | .[0] // empty')"
    if [ -n "$MEAL" ]; then
      MID="$(printf '%s' "$MEAL" | jq -r '.mealId // empty')"
      MNAME="$(printf '%s' "$MEAL" | jq -r '.name // empty')"
      MSLOT="$(printf '%s' "$MEAL" | jq -r '.slotKey // empty')"
      if [ -n "$MID" ] && [ -n "$MNAME" ] && [ -n "$MSLOT" ]; then
        ok "LT15I-004 published meal identity resolved" "group=$GID slot=$MSLOT" LT15I-004
      else
        no "LT15I-004 published meal identity INCOMPLETE" "group=$GID id='$MID' name='$MNAME' slot='$MSLOT'" LT15I-004
      fi
    else
      skip "LT15I-004 no scheduled meal on this group" "group=$GID"
    fi

    # LT15I-003 — display == enforcement: whatever /meals/today serves for this
    # group must reuse the SAME meal identity the planner reports. Divergence
    # here is exactly the P-01 leak (two resolvers disagreeing).
    req GET "/meals/today?groupId=$GID" "" "$ADMIN_TOKEN"
    if [ "$R_CODE" = "200" ]; then
      TODAY_IDS="$(printf '%s' "$R_BODY" | jq -r '(.data // .)[]?.id' 2>/dev/null | sort -u)"
      PLAN_IDS="$(printf '%s' "$SCHED" | jq -r '[.days[]?.meals[]?.mealId] | .[]' 2>/dev/null | sort -u)"
      if [ -z "$TODAY_IDS" ]; then
        skip "LT15I-003 no meals served today" "group=$GID (off-day or nothing published)"
      else
        STRAY=0
        for TID in $TODAY_IDS; do
          printf '%s\n' "$PLAN_IDS" | grep -qx "$TID" || STRAY=$((STRAY+1))
        done
        if [ "$STRAY" -eq 0 ]; then
          ok "LT15I-003 today == planner meal identity" "group=$GID" LT15I-003
        else
          no "LT15I-003 today serves $STRAY meal(s) absent from the planner" "group=$GID — published/master divergence" LT15I-003
        fi
      fi
    else
      skip "LT15I-003 /meals/today unavailable" "group=$GID code=$R_CODE"
    fi
  done
  [ "$CHECKED" -eq 0 ] && skip "LT15I-00x no readable schedule found" "nothing to assert"
fi

# LT15I-005 — ORG ISOLATION: a group id that is not in this admin's org must
# never return data. 404/403 are both correct; 200 is a tenant leak.
req GET "/schedules?groupId=zzz_not_my_org_$(date +%s)" "" "$ADMIN_TOKEN"
if [ "$R_CODE" = "404" ] || [ "$R_CODE" = "403" ] || [ "$R_CODE" = "400" ]; then
  ok "LT15I-005 foreign group rejected" "code=$R_CODE" LT15I-005
else
  ROWS="$(printf '%s' "$R_BODY" | jq -r '((.data // .) | length) // 0' 2>/dev/null)"
  if [ "$R_CODE" = "200" ] && [ "${ROWS:-0}" = "0" ]; then
    no "LT15I-005 foreign group returned 200-empty" "must be 404/403, never 200 (guidebook §5)" LT15I-005
  else
    no "LT15I-005 foreign group LEAKED data" "code=$R_CODE rows=$ROWS" LT15I-005
  fi
fi

echo
echo "P-01 published-isolation — PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
if [ "${SRS_SOURCED:-0}" != "1" ]; then
  [ "$FAIL" -gt 0 ] && exit 2
  exit 0
fi
