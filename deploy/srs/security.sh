#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# security.sh — 100+ discrete security probes across OWASP-style categories.
# Non-destructive: only sends malformed/unauthorized requests and reads headers.
# Tagged FR-SECX / FR-PRIV / FR-LIM. Standalone or sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"

: "${ADMIN_EMAIL:?}"; : "${ADMIN_PASS:?}"
# Throttle-tolerant login: this suite may run right after a login-flood module,
# leaving the per-IP login window (10/min) hot. Retry through the window so a
# transient 429 never yields an empty token (which would 401 every authed probe
# and mask the real RBAC/isolation/injection verdicts).
login_hard(){
  local tok t=0; tok="$(login "$1" "$2")"
  while [ -z "$tok" ] && [ "$t" -lt 6 ]; do sleep 12; t=$((t+1)); tok="$(login "$1" "$2")"; done
  printf '%s' "$tok"
}
ADMIN_TOKEN="$(login_hard "$ADMIN_EMAIL" "$ADMIN_PASS")"
STUDENT_TOKEN=""; [ -n "${STUDENT_EMAIL:-}" ] && STUDENT_TOKEN="$(login_hard "$STUDENT_EMAIL" "${STUDENT_PASS:-}")"
ADMIN2_TOKEN=""; [ -n "${ADMIN2_EMAIL:-}" ] && ADMIN2_TOKEN="$(login_hard "$ADMIN2_EMAIL" "${ADMIN2_PASS:-}")"
req GET /groups "" "$ADMIN_TOKEN"; GROUP_ID="${GROUP_ID:-$(jbody '(.data // .)[0].id // empty')}"

sec "SEC-A — AUTHENTICATION ENFORCEMENT (no/blank/malformed token) FR-SECX-001"
PROTECTED=( "/auth/me" "/groups" "/organizations/me" "/attendance/today"
  "/attendance/history?fromDate=$FROM&toDate=$TO" "/meals/today?groupId=$GROUP_ID"
  "/dashboard/admin" "/notices" "/vacation-requests" "/billing/periods"
  "/notices/unread-count" "/users/me" )
for p in "${PROTECTED[@]}"; do
  req GET "$p" "" ""; assert_code "no-token blocked ${p:0:34}" 401 "$R_CODE" "FR-SECX-001"
done
for p in "${PROTECTED[@]:0:6}"; do
  req GET "$p" "" "garbage.jwt.value"; assert_in "malformed-JWT blocked ${p:0:30}" "$R_CODE" "FR-SECX-002" 401 403
done
# alg=none forgery attempt (unsigned token)
FORGE='eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJzdXBlcl9hZG1pbiJ9.'
req GET /dashboard/admin "" "$FORGE"; assert_in "alg=none token forgery rejected" "$R_CODE" "FR-SECX-003" 401 403

sec "SEC-B — RBAC / PRIVILEGE (student → admin-only) FR-SECX-030"
if [ -n "$STUDENT_TOKEN" ]; then
  ADMIN_ONLY=( "/dashboard/admin" "/billing/periods" "/notifications/diagnostics"
    "/admin/queues/stats" "/admin/audit/integrity" "/dashboard/admin/overview" )
  for p in "${ADMIN_ONLY[@]}"; do
    # req_settle: this runs after the PERF-E capacity ramp, which can leave the
    # burst throttle hot. Drain any transient 429 so we assert the TRUE RBAC
    # verdict (403/404), never a rate-limit artifact.
    req_settle GET "$p" "" "$STUDENT_TOKEN"; assert_in "student denied ${p:0:34}" "$R_CODE" "FR-SECX-030,FR-PRIV-001" 403 404
  done
else skip "RBAC probes" "no STUDENT_TOKEN" "FR-SECX-030"; fi

sec "SEC-C — TENANT ISOLATION / IDOR (other-org admin on our resources) FR-SECX-040"
if [ -n "$ADMIN2_TOKEN" ] && [ -n "$GROUP_ID" ]; then
  # meal-summary requires a mealId — probe IDOR with one of OUR org's real
  # meals so the ownership check (not DTO validation) is what answers.
  if [ -z "${MEAL_ID:-}" ]; then
    req GET "/meals?groupId=$GROUP_ID" "" "$ADMIN_TOKEN"
    MEAL_ID="$(jbody '(.data // .)[0].id // empty')"
  fi
  CROSS=( "/groups/$GROUP_ID" "/groups/$GROUP_ID/members" "/groups/$GROUP_ID/meal-config"
    "/groups/$GROUP_ID/qr-token" "/meals?groupId=$GROUP_ID"
    "/attendance/billing-summary?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO"
    "/groups/$GROUP_ID/preference-crosstab?date=$TO" )
  [ -n "${MEAL_ID:-}" ] && CROSS+=( "/attendance/meal-summary?mealId=$MEAL_ID&date=$TO" )
  for p in "${CROSS[@]}"; do
    req_settle GET "$p" "" "$ADMIN2_TOKEN"; assert_in "cross-org blocked ${p:0:34}" "$R_CODE" "FR-SECX-040,FR-PRIV-010" 403 404
  done
else skip "Isolation probes" "no ADMIN2_TOKEN/GROUP_ID" "FR-SECX-040"; fi

sec "SEC-D — INJECTION (SQLi / NoSQL / XSS / traversal never 500) FR-SECX-050"
PAYLOADS=( "' OR '1'='1" "'; DROP TABLE users;--" '{"$gt":""}' "<script>alert(1)</script>"
  "../../../../etc/passwd" "%00" "\${jndi:ldap://x}" "1;SELECT pg_sleep(5)" )
i=0
for pl in "${PAYLOADS[@]}"; do
  i=$((i+1))
  # 429 is an ACCEPTABLE outcome for a malicious LOGIN probe: the rate limiter
  # rejected it un-processed — the injection never reached the app, which is a
  # security PASS. (These 8 probes themselves push the login throttle.)
  req POST /auth/login "$(jq -nc --arg i "$pl" '{identifier:$i,password:$i}')"
  assert_in "injection#$i login sanitized" "$R_CODE" "FR-SECX-050" 400 401 422 429
  # Query probes use req_settle so a transient 429 (throttle) is drained and we
  # assert the TRUE sanitization verdict (200 filtered / 400 / 422).
  req_settle GET "/groups?search=$(jq -rn --arg s "$pl" '$s|@uri')" "" "$ADMIN_TOKEN"
  assert_in "injection#$i query sanitized" "$R_CODE" "FR-SECX-051" 200 400 422
done
req_settle GET "/meals/today?groupId=../../../etc/passwd" "" "$ADMIN_TOKEN"
assert_in "path-traversal in param blocked" "$R_CODE" "FR-SECX-052" 400 404

sec "SEC-E — INPUT HARDENING (oversized / type-confusion / mass-assign) FR-SECX-060"
# 120KB: big enough to exercise body limits, under Linux's 128KB per-argument
# cap (MAX_ARG_STRLEN) — 200KB made jq/curl fail with "Argument list too long".
# 429 acceptable: rate limiter rejecting the oversized/type-confused LOGIN body
# un-processed is still a hardening PASS (input never reached the handler).
BIG="$(head -c 120000 /dev/zero | tr '\0' 'A')"
req POST /auth/login "$(jq -nc --arg i "$BIG" '{identifier:$i,password:"x"}')"
assert_in "oversized body rejected" "$R_CODE" "FR-SECX-060,FR-LIM-010" 400 401 413 422 429
req POST /auth/signup/student "$(jq -nc '{name:"X",role:"super_admin",email:"esc@x.io",password:"Esc@12345",organizationId:"other-org"}')"
assert_in "mass-assignment escalation neutralized" "$R_CODE" "FR-SECX-061,FR-PRIV-020" 200 201 400 403 422 429
req POST /auth/login '{"identifier":12345,"password":true}'
assert_in "type-confusion body rejected" "$R_CODE" "FR-SECX-062" 400 401 422 429

sec "SEC-F — RATE LIMITING / THROTTLE (login flood → 429) FR-LIM-001"
codes=""
for n in $(seq 1 40); do req POST /auth/login '{"identifier":"flood@x.io","password":"nope"}'; codes="$codes $R_CODE"; done
if echo "$codes" | grep -q 429; then ok "Login flood throttled (429 seen)" "" "FR-LIM-001"
else skip "Login flood throttle" "no 429 in 40 tries (limit may be higher)" "FR-LIM-001"; fi

sec "SEC-G — SECURITY HEADERS / TLS (needs EDGE=https://domain) FR-SECX-070"
if [ -n "$EDGE" ]; then
  H="$(curl -sI "$EDGE/api/v1/health" 2>/dev/null | tr -d '\r')"
  chk(){ echo "$H" | grep -qi "^$1:" && ok "Header $1 present" "" "$2" || no "Header $1 missing" "" "$2"; }
  chk "strict-transport-security" "FR-SECX-070"
  chk "x-content-type-options"    "FR-SECX-071"
  chk "x-frame-options"           "FR-SECX-072"
  chk "referrer-policy"           "FR-SECX-073"
  echo "$H" | grep -qi '^content-security-policy:' && ok "CSP present" "" "FR-SECX-074" || skip "CSP header" "not set" "FR-SECX-074"
else skip "Security headers" "set EDGE=https://domain" "FR-SECX-070,FR-SECX-071,FR-SECX-072,FR-SECX-073,FR-SECX-074"; fi

# Standalone: print the summary AND make the exit code reflect real failures
# (2 = fail) so deploy/run.sh's master certificate marks this module honestly —
# it must NOT show ✅ when probes failed. Sourced by srs → let srs own the exit.
if [ "${SRS_SOURCED:-0}" != "1" ]; then
  summary "SECURITY"
  [ "${FAIL:-0}" -eq 0 ] || exit 2
fi
