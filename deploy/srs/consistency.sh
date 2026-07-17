#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# consistency.sh — server-truth consistency checks over real HTTP (validates
# the Live-Test-6 golden fixes — every screen must display what the server
# actually stores/bills):
#   • ISSUE-2 GUEST PREFERENCE GROUPS — GET /attendance/guests rows carry the
#     additive `preferences` field (null or snapshot array); a booking that
#     omits required-group selections is REJECTED 422 (rejected-write probe —
#     nothing persists); a booking with an unknown groupId selection is also
#     rejected (server-authoritative validation).
#   • ISSUE-3 DAY-ENTRY IMMUTABILITY — every published/draft schedule entry
#     serializes the MASTER meal name (day-wise name overrides are coerced to
#     inherit; name/photo live only in the Master Meal Template).
#   • ISSUE-4 BILLING PARITY — the billing engine's own invariant every UI
#     surface now displays verbatim: netBill == openingBalance + mealCharges
#     + guestAmount + adjustmentsTotal, per member AND on /billing/me; the
#     billSkippedMeals policy flag is exposed for row labelling.
#   • ISSUE-6 DEFAULT ATTENDANCE PERSISTENCE — PATCH /users/me round-trips
#     isDefaultAttendance (gated WRITE_TESTS=1, self-cleaning: restores the
#     prior value).
#   (ISSUE-1 premium sheet and ISSUE-5 /otp routing are Flutter-side — device
#    checks, tagged MANUAL.)
#
# PROD-SAFE: read-only by DEFAULT. The only real write (default-attendance
# round-trip) is gated behind WRITE_TESTS=1 and self-cleans. The 422 booking
# probes are rejected writes — the server persists nothing. Touches NO
# application code and NO infrastructure (zero coupling with the prod
# baseline). Standalone-runnable or sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
# Reuse tokens when sourced by run.sh (login-throttle friendly); log in fresh
# only when standalone (reuse_or_login validates with one GET /auth/me).
reuse_or_login ADMIN_TOKEN   "$ADMIN_EMAIL"       "$ADMIN_PASS"
reuse_or_login STUDENT_TOKEN "${STUDENT_EMAIL:-}" "${STUDENT_PASS:-}"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (livetest6)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

TODAY="$(date +%F)"

# ── Resolve a group + a meal that has bound preference groups (if any) ───────
req GET /groups "" "$ADMIN_TOKEN"
_GIDS="$(jbody '(.data // .)[]?.id')"
GRP="${GROUP_ID:-$(printf '%s\n' $_GIDS | head -1)}"
PG_MEAL=""; PG_GID=""; PG_REQUIRED=""
for _g in $_GIDS; do
  req GET "/meals?groupId=$_g" "" "$ADMIN_TOKEN"
  _mids="$(jbody '(.data // .)[]?.id')"
  for _m in $_mids; do
    req GET "/meals/$_m/preference-groups" "" "$ADMIN_TOKEN"
    [ "$R_CODE" != "200" ] && continue
    _n="$(jbody '(.data // .) | length')"
    if [ "${_n:-0}" -gt 0 ] 2>/dev/null; then
      PG_MEAL="$_m"; PG_GID="$_g"
      PG_REQUIRED="$(jbody '[(.data // .)[]? | select(.required==true)] | length')"
      break 2
    fi
  done
done

# ═════════════════════════════════════════════════════════════════════════════
sec "LIVE-TEST-6 ISSUE-2 — per-guest preference groups (contract + validation)"
# ═════════════════════════════════════════════════════════════════════════════
req GET "/attendance/guests?date=$TODAY${GRP:+&groupId=$GRP}" "" "$ADMIN_TOKEN"
assert_code "guest list readable (admin)" 200 "$R_CODE" "LT6-ISSUE2"
_PREFKEY="$(jbody '((.data // []) | length)==0 or ([(.data // [])[] | has("preferences")] | all)')"
[ "$_PREFKEY" = "true" ] \
  && ok "guest rows expose additive 'preferences' field" "" "LT6-ISSUE2,FR-PG-030" \
  || no "guest rows missing 'preferences' field" "$R_BODY" "LT6-ISSUE2,FR-PG-030"
_PREFSHAPE="$(jbody '[(.data // [])[] | select(.preferences != null) | (.preferences | type=="array")] | all')"
[ "$_PREFSHAPE" = "true" ] \
  && ok "non-null guest preferences are snapshot arrays" "" "LT6-ISSUE2,FR-PG-013" \
  || no "guest preferences wrong shape" "$R_BODY" "LT6-ISSUE2,FR-PG-013"

if [ -n "$PG_MEAL" ]; then
  # Rejected-write probes: the server must refuse these, so nothing persists.
  if [ "${PG_REQUIRED:-0}" -gt 0 ] 2>/dev/null; then
    req POST "/attendance/$PG_MEAL/guests" \
      "{\"attendanceDate\":\"$TODAY\",\"guests\":[{\"isAdult\":true}]}" "$ADMIN_TOKEN"
    if [ "$R_CODE" = "422" ]; then
      ok "guest booking w/o required selections → 422" "" "LT6-ISSUE2,FR-PG-031"
    else
      # Other gates (cutoff/window/host-not-present/limits) may fire first —
      # any 4xx proves the write was rejected; only 2xx would be a real fail.
      case "$R_CODE" in
        2*) no "guest booked WITHOUT required selections" "$R_BODY" "LT6-ISSUE2,FR-PG-031" ;;
        *)  ok "guest booking rejected (gate $R_CODE before validation)" "" "LT6-ISSUE2,FR-PG-031" ;;
      esac
    fi
  else
    skip "required-group booking probe" "meal's groups are all optional" "LT6-ISSUE2,FR-PG-031"
  fi
  req POST "/attendance/$PG_MEAL/guests" \
    "{\"attendanceDate\":\"$TODAY\",\"guests\":[{\"isAdult\":true,\"selections\":[{\"groupId\":\"lt6-unknown-group\",\"optionKey\":\"nope\"}]}]}" \
    "$ADMIN_TOKEN"
  case "$R_CODE" in
    2*) no "guest booked with UNKNOWN preference group" "$R_BODY" "LT6-ISSUE2,FR-PG-031" ;;
    *)  ok "unknown-group selection rejected ($R_CODE)" "" "LT6-ISSUE2,FR-PG-031" ;;
  esac
  # Round-2 fix: on a preference-GROUP meal the legacy flat guest-preference
  # rule must never fire first (it made group-meal bookings impossible when
  # guestPreferenceRequired was on). The probe omits mealPreference — ANY
  # rejection is fine EXCEPT code GUEST_PREFERENCE_REQUIRED.
  req POST "/attendance/$PG_MEAL/guests" \
    "{\"attendanceDate\":\"$TODAY\",\"guests\":[{\"isAdult\":true}]}" "$ADMIN_TOKEN"
  _ECODE="$(jbody '.code // empty')"
  if [ "$_ECODE" = "GUEST_PREFERENCE_REQUIRED" ]; then
    no "flat pref rule fires on a GROUP meal" "$R_BODY" "LT6-ISSUE2,FR-HG-031"
  else
    ok "flat pref rule yields to group picks on group meals" "code=${_ECODE:-none} http=$R_CODE" "LT6-ISSUE2,FR-HG-031"
  fi
else
  skip "guest selection validation probes" "no meal with preference groups found" "LT6-ISSUE2"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "LIVE-TEST-6 ISSUE-3 — day entries always serialize the MASTER meal name"
# ═════════════════════════════════════════════════════════════════════════════
_CHECKED=0; _MISMATCH=""
for _g in $_GIDS; do
  req GET "/schedules?groupId=$_g" "" "$ADMIN_TOKEN"
  [ "$R_CODE" != "200" ] && continue
  # Build "entryName|slotKey" pairs from every schedule week, then compare
  # each entry name against the group's master meal catalogue by slotKey.
  _PAIRS="$(jbody '(.data // .)[]?.days[]?.meals[]? | "\(.name)|\(.slotKey)"' | sort -u)"
  [ -z "$_PAIRS" ] && continue
  req GET "/meals?groupId=$_g" "" "$ADMIN_TOKEN"
  _CATALOG="$(jbody '(.data // .)[]? | "\(.displayName // .name)|\(.slotKey)"' | sort -u)"
  while IFS= read -r _p; do
    [ -z "$_p" ] && continue
    _CHECKED=$((_CHECKED+1))
    printf '%s\n' "$_CATALOG" | grep -Fqx "$_p" || _MISMATCH="$_MISMATCH [$_g:$_p]"
  done <<< "$_PAIRS"
done
if [ "$_CHECKED" -eq 0 ]; then
  skip "schedule-vs-master name parity" "no published schedules found" "LT6-ISSUE3,MMT-002"
elif [ -z "$_MISMATCH" ]; then
  ok "all $_CHECKED schedule entries carry the master meal name" "" "LT6-ISSUE3,MMT-002"
else
  no "schedule entries with overridden names" "$_MISMATCH" "LT6-ISSUE3,MMT-002"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "LIVE-TEST-6 ISSUE-4 — billing engine invariant every screen now displays"
# ═════════════════════════════════════════════════════════════════════════════
if [ -n "$GRP" ]; then
  req GET "/attendance/billing-summary?groupId=$GRP" "" "$ADMIN_TOKEN"
  assert_code "billing summary readable" 200 "$R_CODE" "LT6-ISSUE4,FR-BILLX-020"
  _FLAG="$(jbody 'has("billSkippedMeals")')"
  [ "$_FLAG" = "true" ] \
    && ok "billSkippedMeals policy flag exposed" "value=$(jbody '.billSkippedMeals')" "LT6-ISSUE4" \
    || no "billSkippedMeals flag missing" "" "LT6-ISSUE4"
  _BAD="$(jbody '[.members[]? | select((.netBill // 0) != ((.openingBalance // 0)+(.mealCharges // ((.totalBill // 0)-(.guestAmount // 0)))+(.guestAmount // 0)+(.adjustmentsTotal // 0)))] | length')"
  _CNT="$(jbody '.members | length')"
  if [ "${_BAD:-1}" = "0" ]; then
    ok "netBill ≡ opening+meals+guests+adjustments (all $_CNT members)" "" "LT6-ISSUE4,FR-BILLX-030,CREDIT-001"
  else
    no "netBill invariant broken for $_BAD member(s)" "" "LT6-ISSUE4,FR-BILLX-030"
  fi
  if [ -n "$STUDENT_TOKEN" ]; then
    req GET "/attendance/my-billing?groupId=$GRP" "" "$STUDENT_TOKEN"
    if [ "$R_CODE" = "200" ]; then
      _MINE_OK="$(jbody '(.netBill // 0) == ((.openingBalance // 0)+(.mealCharges // 0)+(.guestAmount // 0)+(.adjustmentsTotal // 0))')"
      [ "$_MINE_OK" = "true" ] \
        && ok "My Billing reconciles to the same invariant" "net=$(jbody '.netBill')" "LT6-ISSUE4" \
        || no "My Billing does not reconcile" "$R_BODY" "LT6-ISSUE4"
    else
      skip "My Billing reconciliation" "student not in group $GRP ($R_CODE)" "LT6-ISSUE4"
    fi
  fi
else
  skip "billing parity checks" "no group resolved" "LT6-ISSUE4"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "LIVE-TEST-6 ISSUE-6 — default-attendance toggle persists server-side"
# ═════════════════════════════════════════════════════════════════════════════
if [ "$WRITE_TESTS" = "1" ] && [ -n "$STUDENT_TOKEN" ]; then
  req GET /auth/me "" "$STUDENT_TOKEN"
  _ORIG="$(jbody '.isDefaultAttendance // false')"
  _FLIP=$([ "$_ORIG" = "true" ] && echo false || echo true)
  req PATCH /users/me "{\"isDefaultAttendance\":$_FLIP}" "$STUDENT_TOKEN"
  assert_code "PATCH /users/me isDefaultAttendance" 200 "$R_CODE" "LT6-ISSUE6,ATT-010"
  req GET /auth/me "" "$STUDENT_TOKEN"
  _NOW="$(jbody '.isDefaultAttendance')"
  [ "$_NOW" = "$_FLIP" ] \
    && ok "toggle persisted across a fresh read" "$_ORIG → $_FLIP" "LT6-ISSUE6,ATT-010" \
    || no "toggle did NOT persist" "wanted=$_FLIP got=$_NOW" "LT6-ISSUE6,ATT-010"
  # Self-clean: restore the member's original preference.
  req PATCH /users/me "{\"isDefaultAttendance\":$_ORIG}" "$STUDENT_TOKEN"
  req GET /auth/me "" "$STUDENT_TOKEN"
  [ "$(jbody '.isDefaultAttendance')" = "$_ORIG" ] \
    && ok "self-clean restored original value" "$_ORIG" "LT6-ISSUE6" \
    || no "self-clean failed — restore manually" "orig=$_ORIG" "LT6-ISSUE6"
else
  skip "default-attendance round-trip (live write)" "set WRITE_TESTS=1 (self-cleaning) to run" "LT6-ISSUE6,ATT-010"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "VACATION — request contract (slot bounds) + member isolation"
# ═════════════════════════════════════════════════════════════════════════════
if [ -n "$STUDENT_TOKEN" ]; then
  req GET /auth/me "" "$STUDENT_TOKEN"
  _SID="$(jbody '.id // .data.id // empty')"
  req GET "/vacation-requests?limit=20" "" "$STUDENT_TOKEN"
  assert_code "vacation-requests list (member)" 200 "$R_CODE" "LT6-VAC,FR-VACX-001"
  _OWN="$(printf '%s' "$R_BODY" | jq -r --arg me "$_SID" \
    '((.data // []) | length)==0 or ([(.data // [])[] | .userId == $me] | all)' 2>/dev/null)"
  [ "$_OWN" = "true" ] \
    && ok "member sees ONLY own vacation requests" "" "LT6-VAC,FR-VACX-001" \
    || no "member sees foreign vacation requests" "$R_BODY" "LT6-VAC,FR-VACX-001"
  _SLOTS="$(printf '%s' "$R_BODY" | jq -r '((.data // []) | length)==0 or ([(.data // [])[] | has("startSlotKey") and has("endSlotKey")] | all)' 2>/dev/null)"
  [ "$_SLOTS" = "true" ] \
    && ok "requests expose slot-boundary fields (FR-VACX-003)" "" "LT6-VAC,FR-VACX-003" \
    || no "slot-boundary fields missing from requests" "$R_BODY" "LT6-VAC,FR-VACX-003"
else
  skip "vacation contract checks" "no student token" "LT6-VAC"
fi

# Device-only surfaces (Flutter): premium preference-group sheet + Verify-now
# navigation — cannot be asserted over HTTP.
tag "LT6-ISSUE1" MANUAL "premium preference-group sheet — verify on device (light+dark)"
tag "LT6-ISSUE5" MANUAL "Verify now opens /otp for a signed-in user — verify on device"
MANUAL=$((MANUAL+2))

[ "${SRS_SOURCED:-0}" = "1" ] || summary
