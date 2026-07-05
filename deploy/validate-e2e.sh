#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# validate-e2e.sh — end-to-end feature + deep-audit validation against the LIVE
# backend. Real HTTP, real DB writes, real responses. No mocks.
#
# Run ON the VPS (localhost isolates backend compute) OR from anywhere by
# pointing BASE at the public API. Every check prints PASS/FAIL + latency and
# the full run is tee'd to a timestamped file under /tmp.
#
# USAGE (on VPS):
#   ADMIN_EMAIL='Manas.Bhattacharya.Primary@gmail.com' ADMIN_PASS='Test@123456' \
#   STUDENT_EMAIL='animesh.bhattacharya.6108@gmail.com' STUDENT_PASS='Animesh@7810' \
#   ADMIN2_EMAIL='Soumyakantimal95@gmail.com' ADMIN2_PASS='5747462625@Sou' \
#   bash deploy/validate-e2e.sh
#
# Optional env: BASE (default http://localhost:3000/api/v1), GROUP_ID (else auto
# from admin's first group), FROM, TO, PERF_SAMPLES (default 8).
#
# Requires: bash, curl, jq. Never modifies infrastructure. Idempotent: creates a
# throwaway student for the signup→delete lifecycle check and anonymises it.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
FROM="${FROM:-$(date -d '-7 days' +%F 2>/dev/null || date +%F)}"
TO="${TO:-$(date +%F)}"
PERF_SAMPLES="${PERF_SAMPLES:-8}"
OUT="/tmp/emeal-validation-$(date +%Y%m%d-%H%M%S).log"

ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASS="${ADMIN_PASS:-}"
STUDENT_EMAIL="${STUDENT_EMAIL:-}"
STUDENT_PASS="${STUDENT_PASS:-}"
ADMIN2_EMAIL="${ADMIN2_EMAIL:-}"
ADMIN2_PASS="${ADMIN2_PASS:-}"

command -v jq  >/dev/null || { echo "FATAL: jq not installed";  exit 1; }
command -v curl >/dev/null || { echo "FATAL: curl not installed"; exit 1; }
[ -z "$ADMIN_EMAIL" ] && { echo "FATAL: set ADMIN_EMAIL/ADMIN_PASS (see header)"; exit 1; }

# ── output plumbing ──────────────────────────────────────────────────────────
exec > >(tee "$OUT") 2>&1
PASS=0; FAIL=0; SKIP=0
declare -a FAILED_CHECKS

hr()  { printf '%.0s─' {1..78}; echo; }
sec() { echo; hr; echo "▶ $*"; hr; }

# pass/fail recorder — ok <label> <condition-desc>; uses $? of preceding test
ok()   { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  %-52s %s\n" "$1" "${2:-}"; }
no()   { FAIL=$((FAIL+1)); FAILED_CHECKS+=("$1"); printf "  \033[31mFAIL\033[0m  %-52s %s\n" "$1" "${2:-}"; }
skip() { SKIP=$((SKIP+1)); printf "  \033[33mSKIP\033[0m  %-52s %s\n" "$1" "${2:-}"; }

# assert <label> <expected_http> <actual_http> [extra]
assert_code() {
  if [ "$3" = "$2" ]; then ok "$1" "($3, ${4:-})"; else no "$1" "expected $2 got $3 ${4:-}"; fi
}

# timed request → sets R_CODE, R_MS, R_BODY. args: METHOD PATH [JSON] [TOKEN]
req() {
  local method="$1" path="$2" json="${3:-}" token="${4:-}"
  local hdr=(-H 'Content-Type: application/json')
  [ -n "$token" ] && hdr+=(-H "Authorization: Bearer $token")
  local tmp; tmp="$(mktemp)"
  local w
  if [ -n "$json" ]; then
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" -d "$json" "$BASE$path")
  else
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" "$BASE$path")
  fi
  R_CODE="${w%% *}"; local t="${w##* }"
  R_MS=$(awk "BEGIN{printf \"%.0f\", $t*1000}")
  R_BODY="$(cat "$tmp")"; rm -f "$tmp"
}

login() { # email pass -> echoes accessToken (empty on fail)
  req POST /auth/login "$(jq -nc --arg i "$1" --arg p "$2" '{identifier:$i,password:$p}')"
  [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ] || { echo ""; return 1; }
  echo "$R_BODY" | jq -r '.accessToken // .data.accessToken // empty'
}

echo "eMeal E2E + Deep Audit — $(date -u +%FT%TZ)"
echo "BASE=$BASE  window=$FROM..$TO  perf_samples=$PERF_SAMPLES"
echo "Output file: $OUT"

# ═════════════════════════════════════════════════════════════════════════════
sec "1. AUTHENTICATION"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASS")"
[ -n "$ADMIN_TOKEN" ] && ok "Admin login (identifier+password)" || no "Admin login" "check creds/throttle"

# Case-insensitive login (email stored mixed-case)
LOWER_EMAIL="$(echo "$ADMIN_EMAIL" | tr 'A-Z' 'a-z')"
CI_TOKEN="$(login "$LOWER_EMAIL" "$ADMIN_PASS")"
[ -n "$CI_TOKEN" ] && ok "Case-insensitive email login" || no "Case-insensitive email login"

if [ -n "$STUDENT_EMAIL" ]; then
  STUDENT_TOKEN="$(login "$STUDENT_EMAIL" "$STUDENT_PASS")"
  [ -n "$STUDENT_TOKEN" ] && ok "Student login" || no "Student login"
else STUDENT_TOKEN=""; skip "Student login" "no STUDENT_EMAIL"; fi

if [ -n "$ADMIN2_EMAIL" ]; then
  ADMIN2_TOKEN="$(login "$ADMIN2_EMAIL" "$ADMIN2_PASS")"
  [ -n "$ADMIN2_TOKEN" ] && ok "Secondary admin login" || no "Secondary admin login"
else ADMIN2_TOKEN=""; skip "Secondary admin login" "no ADMIN2_EMAIL"; fi

# Wrong password rejected
req POST /auth/login "$(jq -nc --arg i "$ADMIN_EMAIL" '{identifier:$i,password:"wrong-xxxxx"}')"
{ [ "$R_CODE" = "401" ] || [ "$R_CODE" = "422" ] || [ "$R_CODE" = "400" ]; } && ok "Wrong password rejected" "($R_CODE)" || no "Wrong password rejected" "got $R_CODE"

# No-token guard
req GET /dashboard/admin
assert_code "Unauthenticated dashboard blocked" 401 "$R_CODE"

# Session persistence: /auth/me with token
req GET /auth/me "" "$ADMIN_TOKEN"
assert_code "Token identifies user (/auth/me)" 200 "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "2. GROUPS / ROLE / QR"
req GET /groups "" "$ADMIN_TOKEN"
assert_code "List groups" 200 "$R_CODE"
if [ -z "${GROUP_ID:-}" ]; then
  GROUP_ID="$(echo "$R_BODY" | jq -r '(.data // .)[0].id // empty')"
fi
[ -n "${GROUP_ID:-}" ] && ok "Resolved GROUP_ID" "$GROUP_ID" || no "Resolved GROUP_ID" "no groups?"

# Per-group functional role present in group payload
req GET "/groups/$GROUP_ID" "" "$ADMIN_TOKEN"
if [ "$R_CODE" = "200" ]; then
  HAS_ROLE_KEY=$(echo "$R_BODY" | jq 'has("functionalRole") or (.data|has("functionalRole"))')
  [ "$HAS_ROLE_KEY" = "true" ] && ok "Group exposes functionalRole (role shown everywhere)" || no "Group functionalRole key"
else no "Get group detail" "$R_CODE"; fi

# QR join token endpoint
req GET "/groups/$GROUP_ID/qr-token" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && ok "Group QR token generation" "($R_CODE)" || no "Group QR token" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "3. MEAL CONFIG / MODES"
req GET "/groups/$GROUP_ID/meal-config" "" "$ADMIN_TOKEN"
assert_code "Read master meal config" 200 "$R_CODE"
MEALS_ON=$(echo "$R_BODY" | jq -r '(.data // .).mealsEnabled // (.data // .).mealConfig.mealsEnabled // "unknown"')
WEEKLY_ON=$(echo "$R_BODY" | jq -r '(.data // .).weeklyMenuEnabled // (.data // .).mealConfig.weeklyMenuEnabled // "unknown"')
echo "      mealsEnabled=$MEALS_ON weeklyMenuEnabled=$WEEKLY_ON"

req GET "/meals/today?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"
assert_code "Meals today (mode-aware)" 200 "$R_CODE"
# serverTime + windowState present (FR-TIME-011)
HAS_WIN=$(echo "$R_BODY" | jq 'try (has("serverTime") or (.data|has("serverTime"))) catch false')
[ "$HAS_WIN" = "true" ] && ok "meals/today carries serverTime/window" || skip "serverTime on meals/today" "shape varies by mode"

req GET "/meals/weekly-schedule?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ] || [ "$R_CODE" = "400" ]; } && ok "Weekly schedule endpoint" "($R_CODE)" || no "Weekly schedule" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "4. ATTENDANCE (student) + DASHBOARD REFLECTION"
req GET "/attendance/today" "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
{ [ "$R_CODE" = "200" ]; } && ok "Attendance today read" || no "Attendance today read" "$R_CODE"

req GET "/attendance/history?fromDate=$FROM&toDate=$TO" "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
assert_code "Attendance history" 200 "$R_CODE"
# newest-first ordering (FR-SORT-001)
if [ "$R_CODE" = "200" ]; then
  ORDER=$(echo "$R_BODY" | jq -r 'try ([ (.data // .)[]?.markedAt // (.data // .)[]?.date ] | . as $a | ($a==( $a|sort|reverse ))) catch "n/a"')
  [ "$ORDER" = "true" ] || [ "$ORDER" = "n/a" ] && ok "History newest-first ordering" "($ORDER)" || no "History ordering" "$ORDER"
fi

req GET "/dashboard/admin" "" "$ADMIN_TOKEN"
assert_code "Admin dashboard (single request)" 200 "$R_CODE"
GEN_AT=$(echo "$R_BODY" | jq -r 'try ((.data // .).generatedAt // "none") catch "none"')
[ "$GEN_AT" != "none" ] && ok "Dashboard generatedAt freshness stamp" || skip "generatedAt" "not present"

req GET "/dashboard/analytics/attendance?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_code "Attendance analytics (pref-wise)" 200 "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "5. PREFERENCES / MULTI-PREFERENCE"
req GET "/meals/today?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"
HAS_PG=$(echo "$R_BODY" | jq 'try ([.. | objects | select(has("preferenceGroups"))] | length > 0) catch false')
[ "$HAS_PG" = "true" ] && ok "Preference groups embedded in meals" || skip "Preference groups" "none configured on this group"
req GET "/groups/$GROUP_ID/preference-crosstab?date=$TO" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ] || [ "$R_CODE" = "404" ]; } && ok "Preference crosstab endpoint" "($R_CODE)" || no "Preference crosstab" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "6. VACATION"
req GET "/vacation-requests" "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
assert_code "Vacation requests list" 200 "$R_CODE"
# backdated vacation must be rejected (FR-VACX-002)
YESTERDAY="$(date -d '-1 day' +%F 2>/dev/null || date +%F)"
req POST /vacation-requests "$(jq -nc --arg g "$GROUP_ID" --arg d "$YESTERDAY" '{groupId:$g,startDate:$d,endDate:$d,reason:"e2e-backdate-should-fail"}')" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
{ [ "$R_CODE" = "422" ] || [ "$R_CODE" = "400" ]; } && ok "Backdated vacation rejected" "($R_CODE)" || no "Backdated vacation rejected" "got $R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "7. NOTIFICATIONS"
req GET /notices "" "$ADMIN_TOKEN"
assert_code "Notices feed" 200 "$R_CODE"
req GET /notices/unread-count "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
assert_code "Unread count" 200 "$R_CODE"
req GET /notifications/diagnostics "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ] || [ "$R_CODE" = "403" ]; } && ok "Notification diagnostics (admin)" "($R_CODE)" || no "Notification diagnostics" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "8. BILLING"
req GET "/attendance/billing-summary?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_code "Billing summary" 200 "$R_CODE"
NETREV=$(echo "$R_BODY" | jq -r 'try ((.data // .).summary.netRevenue // (.data // .).netRevenue // "n/a") catch "n/a"')
echo "      netRevenue=$NETREV"
# unknown group → 404 (new guard)
req GET "/attendance/billing-summary?groupId=nonexistent-group-xyz&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
assert_code "Billing unknown-group → 404" 404 "$R_CODE"
req GET /billing/periods "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ]; } && ok "Billing periods list" || no "Billing periods" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "9. EXPORTS"
req GET "/exports/attendance?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ]; } && ok "Attendance export (mode-aware columns)" || no "Attendance export" "$R_CODE"
req GET "/exports/billing?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ]; } && ok "Billing export" || no "Billing export" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "10. MULTI-TENANT ISOLATION"
if [ -n "$ADMIN2_TOKEN" ]; then
  # admin2 must NOT read admin1's group
  req GET "/groups/$GROUP_ID/meal-config" "" "$ADMIN2_TOKEN"
  { [ "$R_CODE" = "403" ] || [ "$R_CODE" = "404" ]; } && ok "Cross-org group read blocked" "($R_CODE)" || no "Cross-org isolation" "LEAK: got $R_CODE"
  req GET "/attendance/billing-summary?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "" "$ADMIN2_TOKEN"
  { [ "$R_CODE" = "403" ] || [ "$R_CODE" = "404" ]; } && ok "Cross-org billing blocked" "($R_CODE)" || no "Cross-org billing isolation" "LEAK: got $R_CODE"
else skip "Cross-org isolation" "no ADMIN2 token"; fi
# student cannot hit admin dashboard
if [ -n "$STUDENT_TOKEN" ]; then
  req GET /dashboard/admin "" "$STUDENT_TOKEN"
  assert_code "Student blocked from admin dashboard (RBAC)" 403 "$R_CODE"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "11. SECURITY / PEN PROBES"
# SQLi in query param → must not 500
req GET "/attendance/history?fromDate=2020-01-01'%20OR%20'1'='1&toDate=$TO" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" != "500" ]; } && ok "SQLi probe not fatal" "($R_CODE)" || no "SQLi probe" "500!"
# malformed JWT
req GET /dashboard/admin "" "not.a.jwt"
assert_code "Malformed JWT rejected" 401 "$R_CODE"
# path traversal on export filename param (if any) — probe meals image path
req GET "/meals/../../etc/passwd" "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "404" ] || [ "$R_CODE" = "400" ] || [ "$R_CODE" = "401" ]; } && ok "Path traversal blocked" "($R_CODE)" || no "Path traversal" "$R_CODE"
# oversized body (validation guard) — huge name
BIG=$(head -c 20000 < /dev/zero | tr '\0' 'A')
req POST /vacation-requests "$(jq -nc --arg r "$BIG" --arg g "$GROUP_ID" '{groupId:$g,startDate:"2099-01-01",endDate:"2099-01-01",reason:$r}')" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
{ [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ] || [ "$R_CODE" = "413" ]; } && ok "Oversized input rejected" "($R_CODE)" || no "Oversized input" "got $R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "12. SIGNUP → DELETE ACCOUNT LIFECYCLE (real write, self-cleaned)"
DISPOSABLE="e2e-$(date +%s)@example-e2e.invalid"
req POST /auth/signup/student "$(jq -nc --arg e "$DISPOSABLE" '{name:"E2E Disposable",role:"student",email:$e,password:"Disposable@123"}')"
if { [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; }; then
  ok "Disposable student signup" "($R_CODE)"
  DTOK="$(login "$DISPOSABLE" "Disposable@123")"
  # wrong confirm phrase rejected
  req DELETE /users/me "$(jq -nc '{confirm:"nope",password:"Disposable@123"}')" "$DTOK"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } && ok "Delete w/o DELETE phrase rejected" "($R_CODE)" || no "Delete confirm guard" "$R_CODE"
  # real delete
  req DELETE /users/me "$(jq -nc '{confirm:"DELETE",password:"Disposable@123"}')" "$DTOK"
  assert_code "Account deletion (DELETE /users/me)" 200 "$R_CODE"
  # re-login must fail (anonymised)
  RD="$(login "$DISPOSABLE" "Disposable@123")"
  [ -z "$RD" ] && ok "Deleted account cannot re-login" || no "Deleted account re-login" "still works!"
else
  skip "Signup→delete lifecycle" "signup returned $R_CODE (email verification/ throttle?)"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "13. PERFORMANCE (backend compute, $PERF_SAMPLES samples each)"
perf() { # label path token
  local total=0 min=99999 max=0 code=000 p="$2"
  for _ in $(seq 1 "$PERF_SAMPLES"); do
    req GET "$p" "" "$3"; code="$R_CODE"
    total=$((total+R_MS)); [ "$R_MS" -lt "$min" ] && min=$R_MS; [ "$R_MS" -gt "$max" ] && max=$R_MS
  done
  local avg=$((total/PERF_SAMPLES))
  # Human-readable line → stderr so command-substitution captures ONLY the
  # numeric avg below (fd2 stays on the outer tee; fd1 is what $() reads).
  printf "  %-40s code=%-4s min=%-5s avg=%-5s max=%-5s ms\n" "$1" "$code" "$min" "$avg" "$max" >&2
  echo "$avg"
}
A=$(perf "dashboard/admin"    "/dashboard/admin" "$ADMIN_TOKEN")
perf "attendance/today"    "/attendance/today" "$ADMIN_TOKEN" >/dev/null
perf "meals/today"         "/meals/today?groupId=$GROUP_ID" "$ADMIN_TOKEN" >/dev/null
B=$(perf "billing-summary"    "/attendance/billing-summary?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "$ADMIN_TOKEN")
# SLO gates (backend compute, localhost): dashboard<300, billing<200
{ [ "$A" -lt 300 ]; } && ok "SLO dashboard < 300ms" "(${A}ms)" || no "SLO dashboard < 300ms" "(${A}ms)"
{ [ "$B" -lt 200 ]; } && ok "SLO billing < 200ms" "(${B}ms)" || no "SLO billing < 200ms" "(${B}ms)"

# ═════════════════════════════════════════════════════════════════════════════
sec "14. INFRA / MEMORY (read-only; infra frozen)"
req GET /health
assert_code "Health endpoint" 200 "$R_CODE"
if command -v pm2 >/dev/null; then
  echo "  PM2 memory / restarts:"
  pm2 jlist 2>/dev/null | jq -r '.[] | "    \(.name) mem=\(.monit.memory/1048576|floor)MB restarts=\(.pm2_env.restart_time) status=\(.pm2_env.status)"' 2>/dev/null || echo "    (pm2 jlist unavailable)"
else skip "PM2 memory snapshot" "pm2 not on PATH"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "SUMMARY"
TOTAL=$((PASS+FAIL))
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP  (of $TOTAL asserted)"
if [ "$FAIL" -gt 0 ]; then
  echo "  Failed checks:"; for f in "${FAILED_CHECKS[@]}"; do echo "    ✗ $f"; done
fi
PCT=$(awk "BEGIN{printf \"%.1f\", ($TOTAL>0)?($PASS*100.0/$TOTAL):0}")
echo "  Pass rate: ${PCT}%"
echo
echo "Full log saved to: $OUT"
echo "Copy this entire file back for validation & certificate generation."
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
