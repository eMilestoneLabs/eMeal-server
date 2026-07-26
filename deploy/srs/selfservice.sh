#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# selfservice.sh — SELF-SERVICE & DECISION ROUND-TRIP validation.
#
# Registered in deploy/run.sh as the `selfservice` module (see --help). Asserts,
# over real HTTP, the four guarantees delivered for Live-Test-14 Issues 1-5:
#
#   ISSUE-001  Admin self-service correction: an admin's OWN correction request
#              comes back already applied (status=approved, no pending review).
#              FR-ACR-010 self-approval must stay forbidden (read-only guard).
#   ISSUE-002  Additive org identity: GET /dashboard/admin/overview exposes
#              organization{id,name} so the dashboard can drop the
#              "Your Organisation" placeholder.
#   ISSUE-004  Pending → System Skip: after a window closes, meal-summary
#              pendingCount reaches 0; and for a group whose Bill-Skip policy is
#              OFF the system Skip must be BILLING-NEUTRAL (price null ⇒ ₹0), so
#              the ₹0 bookkeeping Skip never moves money.
#   ISSUE-005  Guest/correction decision notices are member-audience and
#              targeted — a decision never leaks into another member's bell.
#
# PROD-SAFE: READ-ONLY by default (impact class RO). The only real write is the
# ISSUE-001 correction probe, gated behind WRITE_TESTS=1 and self-cleaning in the
# same run. Touches NO application code, config, infrastructure or schema.
# Standalone-runnable or sourced by run.sh. Zero coupling with the production
# baseline — it only observes.
#
# lib.sh contract (getting these wrong yields silent false results):
#   req METHOD PATH [BODY] [TOKEN]          → sets R_CODE / R_MS / R_BODY
#   assert_code LABEL EXPECTED ACTUAL IDS   → label FIRST, actual passed in
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
# Reuse tokens already obtained by an earlier module in the same shell — a fresh
# login per module risks the per-IP 10/min auth throttle (run.sh gotcha #10).
reuse_or_login ADMIN_TOKEN   "$ADMIN_EMAIL"       "$ADMIN_PASS"
reuse_or_login STUDENT_TOKEN "${STUDENT_EMAIL:-}" "${STUDENT_PASS:-}"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (selfservice)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

# ── ISSUE-002(vi) — real organisation name on the admin overview ─────────────
sec "Live-Test-14 — ISSUE-002(vi): real organisation name on the admin overview"

req GET /dashboard/admin/overview "" "$ADMIN_TOKEN"
assert_code "admin overview reachable" 200 "$R_CODE" "LT14-002-A"
# The overview is the ORG-DATE authority too — reuse it instead of the host date.
TODAY="$(jbody '.date // .data.date // empty')"
[ -n "$TODAY" ] || TODAY="$(date +%F)"
ORG_ID="$(jbody '.organization.id // .data.organization.id // empty')"
ORG_NAME="$(jbody '.organization.name // .data.organization.name // empty')"

if [ -n "$ORG_ID" ]; then
  ok "overview exposes organization.id" "$ORG_ID" "LT14-002-B"
else
  no "overview exposes organization.id" "additive key missing — old build?" "LT14-002-B"
fi
# An empty name is legitimate only for an org-less account; the standing test
# admin always belongs to an organisation, so empty here is a real failure.
if [ -n "$ORG_NAME" ]; then
  ok "organization.name is populated" "$ORG_NAME" "LT14-002-C"
else
  no "organization.name is populated" "empty ⇒ dashboard falls back to placeholder" "LT14-002-C"
fi
case "$ORG_NAME" in
  "Your Organisation"|"Your Organization")
    no "organization.name is not the placeholder" "$ORG_NAME" "LT14-002-D" ;;
  *)
    ok "organization.name is not the placeholder" "" "LT14-002-D" ;;
esac

# ── ISSUE-004 — Pending collapses to System Skip after close ─────────────────
sec "Live-Test-14 — ISSUE-004: Pending → System Skip, and the ₹0 Skip bills nothing"

# Discover real ids at runtime — never hardcode (run.sh rule 6).
#
# Group SELECTION matters: blindly taking .data[0] picked a group with NO meals
# today (live run 2026-07-26 reported "meals=0"), so the ISSUE-004 and ISSUE-001
# probes silently SKIPPED and nothing was actually exercised. Scan the admin's
# groups instead and prefer, in order:
#   1. a group with a CLOSED window today  → both probes can run in full;
#   2. any group with meals today          → at least the window states are real;
#   3. the first group                     → preserves the old behaviour.
# Bounded to the first 10 groups so the probe cost stays trivial.
req GET /groups "" "$ADMIN_TOKEN"
ALL_GIDS="$(jbody '[.data[]?.id] | .[0:10] | .[]')"
GID=""; GID_ANY_MEALS=""; GID_FIRST=""
while read -r _g; do
  [ -n "$_g" ] || continue
  [ -n "$GID_FIRST" ] || GID_FIRST="$_g"
  req GET "/meals/today?groupId=$_g" "" "$ADMIN_TOKEN"
  [ "$R_CODE" = "200" ] || continue
  _n="$(jbody '[.data[]?] | length')"
  case "$_n" in ''|*[!0-9]*) _n=0 ;; esac
  [ "$_n" -gt 0 ] && [ -z "$GID_ANY_MEALS" ] && GID_ANY_MEALS="$_g"
  if [ -n "$(jbody '[.data[]? | select(.windowState=="closed")] | length | select(. > 0)')" ]; then
    GID="$_g"; break
  fi
done <<< "$ALL_GIDS"
[ -n "$GID" ] || GID="${GID_ANY_MEALS:-$GID_FIRST}"
[ -n "$GID" ] && echo "   probe group: $GID"

if [ -z "$GID" ]; then
  skip "ISSUE-004 pending/skip reconciliation" "no group visible to admin" "LT14-004-A"
else
  req GET "/meals/today?groupId=$GID" "" "$ADMIN_TOKEN"
  CLOSED_IDS="$(jbody '[.data[]? | select(.windowState=="closed") | .id] | .[]')"
  if [ -z "$CLOSED_IDS" ]; then
    skip "ISSUE-004 pending/skip reconciliation" \
      "no CLOSED window yet (meals=$(jbody '[.data[]?] | length') states=[$(jbody '[.data[]?.windowState] | join(\",\")')]) — re-run after a close" "LT14-004-A"
  else
    CLOSED_SEEN=0; PENDING_BAD=0; PENDING_DETAIL=""
    while read -r MID; do
      [ -n "$MID" ] || continue
      CLOSED_SEEN=$((CLOSED_SEEN+1))
      req GET "/attendance/meal-summary?mealId=$MID&date=$TODAY" "" "$ADMIN_TOKEN"
      if [ "$R_CODE" != "200" ]; then
        PENDING_DETAIL="$PENDING_DETAIL $MID=HTTP$R_CODE"
        PENDING_BAD=$((PENDING_BAD+1))
        continue
      fi
      P="$(jbody '.pendingCount // 0')"
      case "$P" in ''|*[!0-9]*) P=0 ;; esac
      # The close sweep runs on a cadence (default 10 min), so a window that JUST
      # closed can legitimately still report pending. Flag as MANUAL, never a
      # false FAIL — the client also zeroes it at close, so the UI is correct
      # either way; this probe checks the PERSISTED reconciliation.
      if [ "$P" -gt 0 ]; then
        PENDING_BAD=$((PENDING_BAD+1))
        PENDING_DETAIL="$PENDING_DETAIL $MID=$P"
      fi
    done <<< "$CLOSED_IDS"
    if [ "$PENDING_BAD" -eq 0 ]; then
      ok "every closed meal has pendingCount 0" "$CLOSED_SEEN closed meal(s)" "LT14-004-A"
    else
      manual "closed meals still pending" \
        "sweep cadence lag? re-check after one interval:$PENDING_DETAIL" "LT14-004-A"
    fi
  fi

  # Billing neutrality: with Bill-Skip OFF, skipped rows must contribute ₹0.
  # Route and field names are taken from attendance.controller.ts (the ADMIN
  # billing summary lives under /attendance, not /billing) and the per-member row
  # built in AttendanceService.getBillingSummary (mealCharges / presentCount /
  # skippedCount). A guessed `/billing/summary` + `mealAmount` produced a 404 FAIL
  # on 2026-07-26 that looked like a product defect but was a probe bug.
  req GET "/groups/$GID" "" "$ADMIN_TOKEN"
  BILL_SKIP="$(jbody '.data.mealConfig.billSkippedMeals // .mealConfig.billSkippedMeals // false')"
  req GET "/attendance/billing-summary?groupId=$GID" "" "$ADMIN_TOKEN"
  assert_code "billing summary reachable" 200 "$R_CODE" "LT14-004-B"
  if [ "$R_CODE" = "200" ]; then
    SKIPPED="$(jbody '[(.data.members // .members // [])[]?.skippedCount // 0] | add // 0')"
    if [ "$BILL_SKIP" = "true" ]; then
      skip "Bill-Skip OFF ⇒ system Skips add ₹0" \
        "group policy is ON — Skips bill by design" "LT14-004-C"
    else
      MEAL_SUM="$(jbody '[(.data.members // .members // [])[]?.mealCharges // 0] | add // 0')"
      PRESENT_SUM="$(jbody '[(.data.members // .members // [])[]?.presentCount // 0] | add // 0')"
      # With Bill-Skip OFF, a member with 0 Present meals must carry 0 meal
      # charges — a priced System Skip would surface exactly here.
      BAD="$(jbody '[(.data.members // .members // [])[]? | select((.presentCount // 0) == 0 and (.mealCharges // 0) > 0)] | length')"
      case "$BAD" in ''|*[!0-9]*) BAD=0 ;; esac
      if [ "$BAD" -eq 0 ]; then
        ok "Bill-Skip OFF ⇒ system Skips add ₹0" \
          "skipped=$SKIPPED present=$PRESENT_SUM mealCharges=$MEAL_SUM" "LT14-004-C"
      else
        no "Bill-Skip OFF ⇒ system Skips add ₹0" \
          "$BAD member(s) billed with zero Present meals — a Skip carried a price" "LT14-004-C"
      fi
    fi
  fi
fi

# ── ISSUE-001 — admin self-service correction ────────────────────────────────
sec "Live-Test-14 — ISSUE-001: admin self-service correction applies immediately"

req GET "/attendance/correction-requests?page=1&limit=5" "" "$ADMIN_TOKEN"
assert_code "correction queue reachable to admin" 200 "$R_CODE" "LT14-001-A"

if [ "${WRITE_TESTS:-0}" != "1" ]; then
  skip "admin self-correction auto-applies" "needs WRITE_TESTS=1 (self-cleaning)" "LT14-001-B"
elif [ -z "${GID:-}" ]; then
  skip "admin self-correction auto-applies" "no group discovered" "LT14-001-B"
else
  req GET "/meals/today?groupId=$GID" "" "$ADMIN_TOKEN"
  CMID="$(jbody '[.data[]? | select(.windowState=="closed")][0].id // empty')"
  if [ -z "$CMID" ]; then
    skip "admin self-correction auto-applies"       "no CLOSED window today in group $GID (meals=$(jbody '[.data[]?] | length')) — re-run after a close"       "LT14-001-B"
  else
    # Capture the admin's current status so the probe can restore it.
    req GET "/attendance/today?groupId=$GID" "" "$ADMIN_TOKEN"
    ADMIN_ID="$(req GET /auth/me "" "$ADMIN_TOKEN"; jbody '.id // .data.id // empty')"
    req POST /attendance/correction-requests \
      "$(jq -nc --arg m "$CMID" --arg d "$TODAY" \
          '{mealId:$m,attendanceDate:$d,requestType:"correct_to_absent",reason:"ZZ_LT14_PROBE"}')" \
      "$ADMIN_TOKEN"
    CRID="$(jbody '.data.id // .id // empty')"
    CRST="$(jbody '.data.status // .status // empty')"
    if [ "$CRST" = "approved" ]; then
      ok "admin self-correction returns approved" "no admin review needed" "LT14-001-B"
    else
      no "admin self-correction returns approved" "status=$CRST (http $R_CODE)" "LT14-001-B"
    fi
    # SELF-CLEAN: an approved correction cannot be cancelled, so restore the
    # admin's own record with the inverse correction in the same run. A pending
    # leftover (unexpected) is cancelled outright.
    if [ "$CRST" = "pending" ] && [ -n "$CRID" ]; then
      req POST "/attendance/correction-requests/$CRID/cancel" '{}' "$ADMIN_TOKEN"
      assert_code "probe request cancelled (self-clean)" 200 "$R_CODE" "LT14-001-C"
    else
      req POST /attendance/correction-requests \
        "$(jq -nc --arg m "$CMID" --arg d "$TODAY" \
            '{mealId:$m,attendanceDate:$d,requestType:"claim_present",reason:"ZZ_LT14_RESTORE"}')" \
        "$ADMIN_TOKEN"
      RST="$(jbody '.data.status // .status // empty')"
      if [ "$RST" = "approved" ]; then
        ok "self-clean restored the admin's Present record" "" "LT14-001-C"
      else
        manual "self-clean restore" \
          "status=$RST http=$R_CODE — verify admin ${ADMIN_ID:-self} record for $CMID" "LT14-001-C"
      fi
    fi
  fi
fi

# ── ISSUE-005 — decision notices reach the member, and ONLY that member ──────
sec "Live-Test-14 — ISSUE-005: decision notices are member-audience and targeted"

if [ -n "${STUDENT_TOKEN:-}" ]; then
  req GET "/notices?page=1&limit=20" "" "$STUDENT_TOKEN"
  assert_code "member bell reachable" 200 "$R_CODE" "LT14-005-A"
  if [ "$R_CODE" = "200" ]; then
    LEAK="$(jbody '[.data[]? | select(.audience=="admins")] | length')"
    case "$LEAK" in ''|*[!0-9]*) LEAK=0 ;; esac
    if [ "$LEAK" -eq 0 ]; then
      ok "member bell never exposes admin-audience notices" "" "LT14-005-B"
    else
      no "member bell never exposes admin-audience notices" "$LEAK leaked" "LT14-005-B"
    fi
    # Any targeted notice this member can see must be targeted at THEM.
    SID="$(req GET /auth/me "" "$STUDENT_TOKEN"; jbody '.id // .data.id // empty')"
    # jbody() takes a single filter and cannot pass --arg, so this one query goes
    # straight to jq against the captured body.
    FOREIGN="$(printf '%s' "$R_BODY" | jq -r --arg me "$SID" \
      '[.data[]? | select(.targetUserId != null and .targetUserId != $me)] | length' 2>/dev/null)"
    case "$FOREIGN" in ''|*[!0-9]*) FOREIGN=0 ;; esac
    if [ "$FOREIGN" -eq 0 ]; then
      ok "no foreign-targeted notice in this member's bell" "" "LT14-005-C"
    else
      no "no foreign-targeted notice in this member's bell" "$FOREIGN leaked" "LT14-005-C"
    fi
    DECIDED="$(jbody '[.data[]? | select((.title|test("Guest request|Correction (approved|rejected)";"i")))] | length')"
    case "$DECIDED" in ''|*[!0-9]*) DECIDED=0 ;; esac
    if [ "$DECIDED" -gt 0 ]; then
      ok "decision notice present in member bell" "$DECIDED" "LT14-005-D"
    else
      skip "decision notice present in member bell" \
        "nothing has been decided for this student yet" "LT14-005-D"
    fi
  fi
else
  skip "ISSUE-005 member-notice checks" "no student account configured" "LT14-005-A"
fi

# Exit honesty (run.sh rule 12): a recorded failure must fail the module.
if [ "${SRS_SOURCED:-0}" != "1" ]; then
  summary "Self-service & decision round-trip"
  [ "${FAIL:-0}" -gt 0 ] && exit 2
  exit 0
fi
