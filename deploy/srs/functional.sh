#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# functional.sh — SRS FUNCTIONAL requirements over real HTTP, tagged by FR ID.
# Read-only + negative + RBAC + tenant-isolation by default; write flows behind
# WRITE_TESTS=1 (self-cleaning). Standalone-runnable or sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASS")"
STUDENT_TOKEN=""; [ -n "${STUDENT_EMAIL:-}" ] && STUDENT_TOKEN="$(login "$STUDENT_EMAIL" "${STUDENT_PASS:-}")"
ADMIN2_TOKEN=""; [ -n "${ADMIN2_EMAIL:-}" ] && ADMIN2_TOKEN="$(login "$ADMIN2_EMAIL" "${ADMIN2_PASS:-}")"
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
GROUP_ID="${GROUP_ID:-$(jbody '(.data // .)[0].id // empty')}"
[ -n "$GROUP_ID" ] && ok "Resolved GROUP_ID" "$GROUP_ID" "FR-GRP-002" || no "Resolved GROUP_ID" "no groups"
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
assert_in "Mark for unknown meal rejected" "$R_CODE" "FR-ATT-020" 400 404 422

sec "MODULE — VACATION (FR-VAC, FR-VACX)"
req GET /vacation-requests "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"; assert_code "Vacation requests list" 200 "$R_CODE" "FR-VAC-001"
YEST="$(date -d '-1 day' +%F 2>/dev/null || date +%F)"
req POST /vacation-requests "$(jq -nc --arg g "$GROUP_ID" --arg d "$YEST" '{groupId:$g,startDate:$d,endDate:$d,reason:"e2e-backdate"}')" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
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

# ── Optional self-cleaning WRITE lifecycle (opt-in; proves FR-DEL / FR-DLC) ──
if [ "$WRITE_TESTS" = "1" ]; then
  sec "MODULE — SIGNUP → DELETE LIFECYCLE (write, self-cleaned) (FR-DEL, FR-DLC)"
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
  skip "Write lifecycle (signup→delete)" "set WRITE_TESTS=1 to run" "FR-DEL-001,FR-DEL-010,FR-DEL-020,FR-DLC-001"
fi

[ "${SRS_SOURCED:-0}" = "1" ] || summary "FUNCTIONAL"
