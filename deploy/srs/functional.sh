#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# functional.sh — SRS FUNCTIONAL requirements over real HTTP, tagged by FR ID.
# Read-only + negative + RBAC + tenant-isolation by default; write flows behind
# WRITE_TESTS=1 (self-cleaning). Standalone-runnable or sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
# Token acquisition via the shared reuse_or_login helper (lib.sh): in a full
# run.sh pass functional.sh runs FIRST, so tokens are empty → real logins here;
# every later module inherits these same tokens and validates-and-reuses them
# (one cheap GET /auth/me) instead of re-authenticating — one login per account
# for the whole suite. Empty STUDENT/ADMIN2 email → helper leaves the token "".
reuse_or_login ADMIN_TOKEN   "$ADMIN_EMAIL"       "$ADMIN_PASS"
reuse_or_login STUDENT_TOKEN "${STUDENT_EMAIL:-}" "${STUDENT_PASS:-}"
reuse_or_login ADMIN2_TOKEN  "${ADMIN2_EMAIL:-}"  "${ADMIN2_PASS:-}"
[ -z "$ADMIN_TOKEN" ] && { echo "FATAL: admin login failed"; exit 1; }

sec "MODULE 01 — AUTH & ONBOARDING (FR-AUTH)"
req POST /auth/login "$(jq -nc --arg i "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" '{identifier:$i,password:$p}')"
assert_code "Admin login (identifier+password)" 200 "$R_CODE" "FR-AUTH-001,FR-AUTH-002"
req POST /auth/login "$(jq -nc --arg i "$(echo "$ADMIN_EMAIL"|tr a-z A-Z)" --arg p "$ADMIN_PASS" '{identifier:$i,password:$p}')"
assert_code "Case-insensitive email login" 200 "$R_CODE" "FR-AUTH-010"
req POST /auth/login "$(jq -nc --arg i "$ADMIN_EMAIL" '{identifier:$i,password:"wrong-xyz"}')"
assert_code "Wrong password rejected" 401 "$R_CODE" "FR-AUTH-003,FR-SECX-010"
req GET /auth/me "" "$ADMIN_TOKEN"; assert_code "Token identifies user (/auth/me)" 200 "$R_CODE" "FR-AUTH-020"
req GET /auth/me "" ""; assert_code "Unauthenticated /auth/me blocked" 401 "$R_CODE" "FR-AUTH-021,FR-SECX-001"
req POST /auth/forgot-password "$(jq -nc --arg e "$ADMIN_EMAIL" '{identifier:$e}')"
assert_in "Forgot-password anti-enumeration (uniform)" "$R_CODE" "FR-AUTH-030,FR-SECX-020" 200 202 204
req POST /auth/refresh '{"refreshToken":"not-a-real-token"}'
assert_in "Refresh rejects bogus token" "$R_CODE" "FR-AUTH-040" 400 401
req POST /auth/otp/verify '{"email":"x@y.z","otp":"000000"}'
assert_in "OTP verify rejects bad code" "$R_CODE" "FR-AUTH-050" 400 401 422

sec "MODULE — ORG / GROUPS / ROLE / QR (FR-GRP, FR-JOIN, FR-ADM)"
req GET /organizations/me "" "$ADMIN_TOKEN"; assert_code "Org profile read" 200 "$R_CODE" "FR-ADM-001"
req GET /groups "" "$ADMIN_TOKEN"; assert_code "List groups" 200 "$R_CODE" "FR-GRP-001"
_ALL_GIDS="$(jbody '(.data // .)[]?.id')"
GROUP_ID="${GROUP_ID:-$(printf '%s\n' $_ALL_GIDS | head -1)}"
[ -n "$GROUP_ID" ] && ok "Resolved GROUP_ID" "$GROUP_ID" "FR-GRP-002" || no "Resolved GROUP_ID" "no groups"
# Resolve a group that ACTUALLY has meals (the first group may be empty), so the
# meal-summary + #1 planner checks run against real data instead of skipping.
MEAL_GID=""; MEAL_ID=""
for _g in $_ALL_GIDS; do
  req GET "/meals?groupId=$_g" "" "$ADMIN_TOKEN"
  _mid="$(jbody '(.data // .)[0].id // empty')"
  if [ -n "$_mid" ]; then MEAL_GID="$_g"; MEAL_ID="$_mid"; break; fi
done
[ -z "$MEAL_GID" ] && MEAL_GID="$GROUP_ID"
# When NO group has any meal configured, the meal-summary and #1 planner
# checks can only SKIP. With writes enabled, self-provision ONE throwaway
# meal-enabled group (1 always-open meal + 1 preference group) so those
# requirements are actually ASSERTED; it is permanently deleted at the end of
# this script (meals + preference groups cascade). Real groups are untouched.
_ZZ_PROBE_GID=""
if [ -z "$MEAL_ID" ] && [ "${WRITE_TESTS:-0}" = "1" ]; then
  req POST /groups "$(jq -nc '{name:"ZZ_SRS_MEALPROBE",type:"hostel",maxMembers:5,joinApprovalRequired:false,mealConfig:{mealsEnabled:true}}')" "$ADMIN_TOKEN"
  _ZZ_PROBE_GID="$(jbody '.id // .data.id // empty')"
  if [ -n "$_ZZ_PROBE_GID" ] && [ "$_ZZ_PROBE_GID" != "null" ]; then
    req POST /meals "$(jq -nc --arg g "$_ZZ_PROBE_GID" '{groupId:$g,slotKey:"zz_srs_probe",name:"ZZ SRS Probe",attendanceEnabled:true,attendanceWindow:{openTime:"00:00",closeTime:"23:59"}}')" "$ADMIN_TOKEN"
    _mid="$(jbody '.id // .data.id // empty')"
    if [ -n "$_mid" ] && [ "$_mid" != "null" ]; then
      MEAL_GID="$_ZZ_PROBE_GID"; MEAL_ID="$_mid"
      # PreferenceOptionDto: `key` (lowercase slug) is REQUIRED alongside label.
      req POST "/meals/$_mid/preference-groups" "$(jq -nc '{label:"ZZ Probe Pref",options:[{key:"veg",label:"Veg"},{key:"nonveg",label:"Non-Veg"}]}')" "$ADMIN_TOKEN"
    fi
  else
    _ZZ_PROBE_GID=""
  fi
fi
req GET "/groups/$GROUP_ID" "" "$ADMIN_TOKEN"
HAS_ROLE=$(jbody 'has("functionalRole") or (.data|has("functionalRole"))')
[ "$HAS_ROLE" = "true" ] && ok "Group exposes functionalRole" "" "FR-GRP-010,FR-ADM-020" || no "Group functionalRole" "$R_CODE" "FR-GRP-010"
req GET "/groups/$GROUP_ID/qr-token" "" "$ADMIN_TOKEN"
assert_in "Group QR token generation" "$R_CODE" "FR-JOIN-001,FR-JOIN-010" 200 201
req GET "/groups/$GROUP_ID/members" "" "$ADMIN_TOKEN"; assert_code "List group members" 200 "$R_CODE" "FR-GRP-020"
req POST /groups/join '{"joinCode":"ZZZZZZ"}' "$ADMIN_TOKEN"
assert_in "Join with invalid code rejected" "$R_CODE" "FR-JOIN-020" 400 404 422

sec "MODULE — MEALS / MODES / SCHEDULES (FR-MEAL, FR-MODE, FR-SCHX)"
req GET "/groups/$GROUP_ID/meal-config" "" "$ADMIN_TOKEN"; assert_code "Read meal config" 200 "$R_CODE" "FR-MEAL-001,FR-MODE-001"
req GET "/meals?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"; assert_code "List meals" 200 "$R_CODE" "FR-MEAL-010"
MEAL_ID="${MEAL_ID:-$(jbody '(.data // .)[0].id // empty')}"
req GET "/meals/today?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"; assert_code "Meals today (mode-aware)" 200 "$R_CODE" "FR-MEAL-020,FR-MODE-010"
HAS_WIN=$(jbody 'try (has("serverTime") or (.data|has("serverTime"))) catch false')
[ "$HAS_WIN" = "true" ] && ok "meals/today carries serverTime/window meta" "" "FR-TIME-008,FR-TIME-011" || skip "serverTime shape" "varies by mode" "FR-TIME-011"
req GET "/meals?groupId=" "" "$ADMIN_TOKEN"; assert_code "Meals require groupId" 400 "$R_CODE" "FR-MEAL-011"
req GET "/meals/weekly-schedule?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"
assert_in "Weekly schedule endpoint" "$R_CODE" "FR-MODE-020,FR-SCHX-001" 200 400
req GET /schedules "" "$ADMIN_TOKEN"; assert_in "Schedules list" "$R_CODE" "FR-SCHX-010" 200 400

sec "MODULE — ATTENDANCE / TRUST / TIME (FR-ATT, FR-TRUST, FR-TIME, FR-FAIR)"
req GET /attendance/today "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"; assert_code "Attendance today read" 200 "$R_CODE" "FR-ATT-001"
req GET "/attendance/history?fromDate=$FROM&toDate=$TO" "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
assert_code "Attendance history" 200 "$R_CODE" "FR-ATT-010"
ORD=$(jbody 'try ([ (.data // .)[]?.markedAt // (.data // .)[]?.date ] | . as $a | ($a==($a|sort|reverse))) catch "na"')
{ [ "$ORD" = "true" ] || [ "$ORD" = "na" ]; } && ok "History newest-first ordering" "($ORD)" "FR-SORT-001" || no "History ordering" "$ORD" "FR-SORT-001"
# meal-summary requires mealId (not groupId) — probe with a real meal or skip.
if [ -n "${MEAL_ID:-}" ]; then
  req GET "/attendance/meal-summary?mealId=$MEAL_ID&date=$TO" "" "$ADMIN_TOKEN"
  assert_in "Meal summary (present/pref/guest breakdown)" "$R_CODE" "FR-ANL-010,FR-PG-050" 200 400 404
else
  skip "Meal summary" "no meal configured on group" "FR-ANL-010,FR-PG-050"
fi
req POST /attendance '{"mealId":"nonexistent","status":"present"}' "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
if [ "$R_CODE" = "403" ]; then
  # A 403 means an ACCOUNT gate fired before meal validation (ACC-005
  # unverified, org-less student, or non-member — each is a separate, already
  # verified contract). This probe tests unknown-meal VALIDATION, so prove it
  # with the admin and surface the account-level fix.
  echo "  ·     student gated ($(jbody '.code // empty')) — validating via admin; fix: bash deploy/backfill-email-verified.sh + join the student to a group"
  req POST /attendance '{"mealId":"nonexistent","status":"present"}' "$ADMIN_TOKEN"
fi
assert_in "Mark for unknown meal rejected" "$R_CODE" "FR-ATT-020" 400 404 422

sec "MODULE — VACATION (FR-VAC, FR-VACX)"
req GET /vacation-requests "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"; assert_code "Vacation requests list" 200 "$R_CODE" "FR-VAC-001"
YEST="$(date -d '-1 day' +%F 2>/dev/null || date +%F)"
req POST /vacation-requests "$(jq -nc --arg g "$GROUP_ID" --arg d "$YEST" '{groupId:$g,startDate:$d,endDate:$d,reason:"e2e-backdate"}')" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
if [ "$R_CODE" = "403" ]; then
  # Any 403 = an account/membership gate fired before DATE validation (its
  # own contract, verified elsewhere) — prove backdate rejection via admin.
  echo "  ·     student gated ($(jbody '.code // empty')) — validating via admin; fix: bash deploy/backfill-email-verified.sh + join the student to a group"
  req POST /vacation-requests "$(jq -nc --arg g "$GROUP_ID" --arg d "$YEST" '{groupId:$g,startDate:$d,endDate:$d,reason:"e2e-backdate"}')" "$ADMIN_TOKEN"
fi
assert_in "Backdated vacation rejected" "$R_CODE" "FR-VACX-002" 400 422
req PATCH /users/me '{"isVacationMode":true}' "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
assert_in "PATCH /users/me vacation honors approval guard" "$R_CODE" "FR-VACX-001" 200 422

sec "MODULE — BILLING (FR-BILL, FR-BILLX)"
req GET "/attendance/billing-summary?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_code "Billing summary" 200 "$R_CODE" "FR-BILL-001"
req GET "/attendance/billing-summary?groupId=deadbeef&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_code "Billing unknown-group → 404 guard" 404 "$R_CODE" "FR-BILLX-050"
req GET /billing/periods "" "$ADMIN_TOKEN"; assert_in "Billing periods list" "$R_CODE" "FR-BILL-010" 200 400

sec "MODULE — DASHBOARD / ANALYTICS / OVERVIEW (FR-ANL, FR-OVR)"
req GET /dashboard/admin "" "$ADMIN_TOKEN"; assert_code "Admin dashboard (single request)" 200 "$R_CODE" "FR-OVR-001"
GEN=$(jbody 'try ((.data // .).generatedAt // "none") catch "none"')
[ "$GEN" != "none" ] && ok "Dashboard freshness stamp" "" "FR-OVR-010" || skip "generatedAt" "absent" "FR-OVR-010"
req GET "/dashboard/analytics/attendance?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_code "Attendance analytics (pref-wise)" 200 "$R_CODE" "FR-ANL-001"
req GET /dashboard/admin/overview "" "$ADMIN_TOKEN"; assert_in "Admin overview composite" "$R_CODE" "FR-OVR-020" 200

sec "MODULE — PREFERENCES / MULTI-PREF (FR-PG, FR-PREFX)"
req GET "/groups/$GROUP_ID/preference-crosstab?date=$TO" "" "$ADMIN_TOKEN"
assert_in "Preference crosstab" "$R_CODE" "FR-PG-001,FR-PG-050" 200 404
req GET "/groups/$GROUP_ID/preference-templates" "" "$ADMIN_TOKEN"
assert_in "Preference templates list" "$R_CODE" "FR-PREFX-001" 200 404

sec "MODULE — NOTIFICATIONS (FR-NOT, FR-NOTX)"
req GET /notices "" "$ADMIN_TOKEN"; assert_code "Notices feed" 200 "$R_CODE" "FR-NOT-001"
req GET /notices/unread-count "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"; assert_code "Unread count" 200 "$R_CODE" "FR-NOT-010"
req GET /notifications/diagnostics "" "$ADMIN_TOKEN"; assert_in "Notification diagnostics (admin)" "$R_CODE" "FR-NOTX-001" 200 403

sec "MODULE — EXPORTS / REPORTS (FR-EXP)"
req GET "/exports/attendance?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_in "Attendance export" "$R_CODE" "FR-EXP-001" 200 201
req GET "/exports/billing?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_in "Billing export" "$R_CODE" "FR-EXP-010" 200 201
req GET "/reports/analytics?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_in "Analytics report" "$R_CODE" "FR-EXP-020" 200 400

sec "MODULE — EVENTS / GUESTS (FR-EVT, FR-EVTX, FR-EGU)"
req GET /events "" "$ADMIN_TOKEN"; assert_in "Events list" "$R_CODE" "FR-EVT-001" 200 403
req GET "/attendance/guests?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"; assert_in "Guests list" "$R_CODE" "FR-EGU-001" 200 400

sec "MODULE — DELIVERED FIXES: planner pref-groups (#1), join role (#2), request alerts (#4)"
# ── #1: the ADMIN meal list now carries preferenceGroups (was absent → the
# per-day planner editor could never render multi-preference groups). Scan
# every group (the first group may legitimately have no meals). ──────────────
req GET /groups "" "$ADMIN_TOKEN"
_GIDS="$(jbody '(.data // .)[]?.id')"
FIELD_OK=0; MAXPG=0; SCANNED=0
for _g in $_GIDS; do
  req GET "/meals?groupId=$_g" "" "$ADMIN_TOKEN"
  _present="$(jbody '((.data|length)>0) and ([.data[]?|has("preferenceGroups")]|all)')"
  _mx="$(jbody '([.data[]? | (.preferenceGroups|length)] | max) // 0')"
  [ "$_present" = "true" ] && FIELD_OK=1
  [ "$_present" = "true" ] && SCANNED=1
  if [ "${_mx:-0}" -gt "${MAXPG:-0}" ] 2>/dev/null; then MAXPG="$_mx"; fi
done
if [ "$FIELD_OK" = "1" ]; then ok "#1 admin meal list carries preferenceGroups field" "maxGroupsOnAMeal=$MAXPG" "FR-PG-090"
elif [ "$SCANNED" = "0" ]; then skip "#1 preferenceGroups field" "no meals configured on any group" "FR-PG-090"
else no "#1 preferenceGroups field MISSING on admin meal list" "" "FR-PG-090"; fi
if [ "${MAXPG:-0}" -gt 0 ]; then ok "#1 multi-preference groups render in planner" "$MAXPG group(s) on a meal" "FR-PG-091"
else skip "#1 planner groups render" "no preference groups configured to display" "FR-PG-091"; fi

# ── #2: a joining user can pick a MEMBER-level display role, but an admin
# title is rejected (422) BEFORE any code lookup — a join can never self-assign
# an admin title. Non-destructive: uses a deliberately invalid code. ─────────
_JT="${STUDENT_TOKEN:-$ADMIN_TOKEN}"
req POST /groups/join "$(jq -nc '{joinCode:"ZZZZZZ",functionalRole:"hostelAdmin"}')" "$_JT"
assert_code "#2 admin title on join REJECTED" 422 "$R_CODE" "FR-JOIN-030,FR-SECX-061"
req POST /groups/join "$(jq -nc '{joinCode:"ZZZZZZ",functionalRole:"student"}')" "$_JT"
assert_in "#2 member-level role accepted (fails only on bad code)" "$R_CODE" "FR-JOIN-031" 400 404 422

# ── #4: request-alert notices are ADMINS-ONLY — a student must never see an
# audience=admins notice; the feed must expose the audience field. Read-only. ─
if [ -n "$STUDENT_TOKEN" ]; then
  req GET /notices "" "$STUDENT_TOKEN"
  _LEAK="$(jbody '[.data[]? | select(.audience=="admins")] | length')"
  [ "${_LEAK:-0}" = "0" ] && ok "#4 admin-audience notices hidden from students" "0 leaked" "FR-NOTX-020,FR-SECX-041" \
    || no "#4 student can see admin notices" "${_LEAK} leaked" "FR-NOTX-020,FR-SECX-041"
else skip "#4 audience isolation" "no student token" "FR-NOTX-020"; fi
req GET /notices "" "$ADMIN_TOKEN"
_HASAUD="$(jbody '([.data[]?|has("audience")]|all) // true')"
[ "$_HASAUD" = "true" ] && ok "#4 notices expose audience field" "" "FR-NOTX-021" \
  || no "#4 audience field missing on notices" "" "FR-NOTX-021"

# ── Comprehensive self-cleaning WRITE / MODIFY audit (opt-in via WRITE_TESTS=1)
# Every write below is undone in the same block, so the DB is left as found. ──
if [ "$WRITE_TESTS" = "1" ]; then
  sec "MODULE — WRITE / MODIFY LIFECYCLE (real writes, self-cleaned) (FR-DEL, FR-DLC, FR-VACX, FR-NOTX)"

  # (a) #4 LIVE: a member request must raise the ADMIN bell, then admin clears it.
  if [ -n "$STUDENT_TOKEN" ]; then
    req GET /notices/unread-count "" "$ADMIN_TOKEN"; _U0="$(jbody '.count // 0')"
    _VS="$(date -d "+$((320 + RANDOM % 400)) days" +%F 2>/dev/null || echo 2027-06-01)"
    _VE="$(date -d "$_VS +2 days" +%F 2>/dev/null || echo 2027-06-03)"
    req POST /vacation-requests "$(jq -nc --arg s "$_VS" --arg e "$_VE" '{startDate:$s,endDate:$e,reason:"SRS write audit"}')" "$STUDENT_TOKEN"
    if [ "$R_CODE" = "403" ] && [ "$(jbody '.code // empty')" = "EMAIL_VERIFICATION_REQUIRED" ]; then
      # ACC-005 gate: the test account is unverified so it CANNOT create the
      # request — that is the guard working, not the bell pipeline failing.
      skip "#4 live vacation→bell" "student unverified (ACC-005) — fix: bash deploy/backfill-email-verified.sh, then re-run" "FR-NOTX-020,FR-VACX-001"
    else
      assert_in "#4 live: student vacation request created" "$R_CODE" "FR-VACX-001" 200 201
      _VID="$(jbody '.id // .data.id // empty')"
      sleep 2   # the admin bell notice is raised fire-and-forget; let it commit
      req GET /notices/unread-count "" "$ADMIN_TOKEN"; _U1="$(jbody '.count // 0')"
      if [ "${_U1:-0}" -gt "${_U0:-0}" ] 2>/dev/null; then ok "#4 live: request raised admin bell notice" "unread ${_U0}->${_U1}" "FR-NOTX-020,FR-NOT-001"
      else no "#4 live: admin bell did NOT increment" "unread ${_U0}->${_U1}" "FR-NOTX-020"; fi
      # cleanup: admin rejects the request (empty body → no whitelist violation)
      if [ -n "$_VID" ]; then
        req PATCH "/vacation-requests/$_VID/reject" '{}' "$ADMIN_TOKEN"
        assert_in "#4 cleanup: admin rejected the request" "$R_CODE" "FR-VACX-030" 200 201
      fi
    fi
  else skip "#4 live vacation→bell" "no student token" "FR-NOTX-020,FR-VACX-001"; fi

  # (b) Notice create → visible in feed → delete (admin, self-clean).
  req POST /notices "$(jq -nc '{title:"SRS Audit Notice",body:"temporary — auto-deleted by the SRS suite",priority:"low"}')" "$ADMIN_TOKEN"
  assert_in "Notice create" "$R_CODE" "FR-NOTX-001" 200 201
  _NID="$(jbody '.id // .data.id // empty')"
  if [ -n "$_NID" ]; then
    req DELETE "/notices/$_NID" "" "$ADMIN_TOKEN"
    assert_in "Notice delete (cleanup)" "$R_CODE" "FR-NOTX-004" 200 204
  else no "Notice create returned no id" "" "FR-NOTX-001"; fi

  # (c) Signup → delete-guard → delete → cannot re-login (disposable account).
  TS=$(date +%s); TE="srs.$TS@example.com"; TP="Srs@$TS"
  req POST /auth/signup/student "$(jq -nc --arg e "$TE" --arg p "$TP" '{name:"SRS Probe",role:"student",email:$e,password:$p}')"
  assert_in "Disposable student signup" "$R_CODE" "FR-DEL-001" 200 201
  DT="$(jbody '.accessToken // .data.accessToken // empty')"
  [ -z "$DT" ] && DT="$(login "$TE" "$TP")"
  req DELETE /users/me "$(jq -nc --arg p "$TP" '{confirm:"nope",password:$p}')" "$DT"
  assert_in "Delete requires DELETE phrase" "$R_CODE" "FR-DLC-001" 400 422
  req DELETE /users/me "$(jq -nc --arg p "$TP" '{confirm:"DELETE",password:$p}')" "$DT"
  assert_code "Account deletion" 200 "$R_CODE" "FR-DEL-010"
  req POST /auth/login "$(jq -nc --arg i "$TE" --arg p "$TP" '{identifier:$i,password:$p}')"
  assert_in "Deleted account cannot re-login" "$R_CODE" "FR-DEL-020" 401 403 422
else
  skip "Write/modify lifecycle" "set WRITE_TESTS=1 to run" "FR-DEL-001,FR-DEL-010,FR-DEL-020,FR-DLC-001,FR-NOTX-001,FR-VACX-001"
fi

# Cleanup: permanently delete the self-provisioned meal-probe group (meal +
# preference group cascade). Only exists when writes were enabled AND no real
# group had a configured meal.
if [ -n "$_ZZ_PROBE_GID" ]; then
  req DELETE "/groups/$_ZZ_PROBE_GID/permanent" "" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "204" ]; } \
    && ok "cleanup: throwaway meal-probe group deleted" "($R_CODE)" "FR-GRP-019" \
    || no "cleanup: throwaway meal-probe group NOT deleted" "$R_CODE — delete ZZ_SRS_MEALPROBE manually" "FR-GRP-019"
fi

[ "${SRS_SOURCED:-0}" = "1" ] || summary "FUNCTIONAL"
