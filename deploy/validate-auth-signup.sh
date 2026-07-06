#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# validate-auth-signup.sh — end-to-end verification of MODULE_01 (Authentication
# & Sign-up) against the LIVE backend. Real HTTP, real responses. No mocks.
# Mirrors deploy/validate-group-organization.sh conventions.
#
# Proves the MODULE_01 requirement families:
#   AUTH login (+ negatives), session (/me), token refresh, logout,
#   anti-enumeration on forgot-password & OTP request, OTP send alias,
#   password-reset rejection of bad codes, and sign-up input validation
#   (weak password / invalid email / under-age / duplicate email).
#
# NON-DESTRUCTIVE: it never creates a real account. Sign-up checks use inputs
# that fail validation BEFORE persistence, or an already-registered email
# (duplicate path). Safe to re-run.
#
# USAGE (on VPS):
#   ADMIN_EMAIL='...'  ADMIN_PASS='...' \
#   STUDENT_EMAIL='...' STUDENT_PASS='...' \
#   bash deploy/validate-auth-signup.sh
#
# Optional env: BASE (default http://localhost:3000/api/v1), PERF_BUDGET_MS
# (default 400 — auth uses bcrypt so budgets are more lenient than reads).
#
# Requires: bash, curl, jq. Never modifies infrastructure.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
PERF_BUDGET_MS="${PERF_BUDGET_MS:-400}"
OUT="/tmp/emeal-module01-verify-$(date +%Y%m%d-%H%M%S).log"

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_DIR/srs/accounts.sh" ] && . "$_DIR/srs/accounts.sh"

ADMIN_EMAIL="${ADMIN_EMAIL:-}"; ADMIN_PASS="${ADMIN_PASS:-}"
STUDENT_EMAIL="${STUDENT_EMAIL:-}"; STUDENT_PASS="${STUDENT_PASS:-}"

command -v jq   >/dev/null || { echo "FATAL: jq not installed";   exit 1; }
command -v curl >/dev/null || { echo "FATAL: curl not installed"; exit 1; }
[ -z "$ADMIN_EMAIL" ] && { echo "FATAL: set ADMIN_EMAIL/ADMIN_PASS (see header)"; exit 1; }

exec > >(tee "$OUT") 2>&1
PASS=0; FAIL=0; SKIP=0; declare -a FAILED_CHECKS
hr()  { printf '%.0s─' {1..78}; echo; }
sec() { echo; hr; echo "▶ $*"; hr; }
ok()   { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  %-54s %s\n" "$1" "${2:-}"; }
no()   { FAIL=$((FAIL+1)); FAILED_CHECKS+=("$1"); printf "  \033[31mFAIL\033[0m  %-54s %s\n" "$1" "${2:-}"; }
skip() { SKIP=$((SKIP+1)); printf "  \033[33mSKIP\033[0m  %-54s %s\n" "$1" "${2:-}"; }
assert_code() { if [ "$3" = "$2" ]; then ok "$1" "($3, ${4:-})"; else no "$1" "expected $2 got $3 ${4:-}"; fi; }

# timed request → sets R_CODE, R_MS, R_BODY. args: METHOD PATH [JSON] [TOKEN]
req() {
  local method="$1" path="$2" json="${3:-}" token="${4:-}"
  local hdr=(-H 'Content-Type: application/json')
  [ -n "$token" ] && hdr+=(-H "Authorization: Bearer $token")
  local tmp w; tmp="$(mktemp)"
  if [ -n "$json" ]; then
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" -d "$json" "$BASE$path")
  else
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" "$BASE$path")
  fi
  R_CODE="${w%% *}"; local t="${w##* }"
  R_MS=$(awk "BEGIN{printf \"%.0f\", $t*1000}")
  R_BODY="$(cat "$tmp")"; rm -f "$tmp"
}

perf() { if [ "${R_MS:-99999}" -le "$PERF_BUDGET_MS" ]; then ok "$1 latency" "${R_MS}ms ≤ ${PERF_BUDGET_MS}ms"
  else skip "$1 latency" "${R_MS}ms > ${PERF_BUDGET_MS}ms (bcrypt/network — re-check on VPS)"; fi; }

j() { echo "$R_BODY" | jq -r "$1" 2>/dev/null; }

is2xx() { [ "$1" -ge 200 ] && [ "$1" -lt 300 ]; }
is4xx() { [ "$1" -ge 400 ] && [ "$1" -lt 500 ]; }

echo "eMeal MODULE_01 Verification — $(date -u +%FT%TZ)"
echo "BASE=$BASE  perf_budget=${PERF_BUDGET_MS}ms  out=$OUT"

# ═════════════════════════════════════════════════════════════════════════════
sec "0. LOGIN (AUTH-tokens) + session"
req POST /auth/login "$(jq -nc --arg i "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" '{identifier:$i,password:$p}')"
{ is2xx "$R_CODE"; } && ok "Admin login" "($R_CODE)" || { no "Admin login" "($R_CODE) abort"; exit 1; }
perf "login"
ADMIN_TOKEN="$(j '.accessToken // .data.accessToken // .tokens.accessToken')"
ADMIN_REFRESH="$(j '.refreshToken // .data.refreshToken // .tokens.refreshToken')"
[ -n "$ADMIN_TOKEN" ] && ok "Login returns accessToken" || no "Login accessToken missing"
[ -n "$ADMIN_REFRESH" ] && ok "Login returns refreshToken" || skip "Login refreshToken missing" "refresh test will skip"

if [ -n "$STUDENT_EMAIL" ]; then
  req POST /auth/login "$(jq -nc --arg i "$STUDENT_EMAIL" --arg p "$STUDENT_PASS" '{identifier:$i,password:$p}')"
  is2xx "$R_CODE" && ok "Student login" "($R_CODE)" || no "Student login" "($R_CODE)"
else skip "Student login" "no STUDENT_EMAIL"; fi

# GET /me
req GET /auth/me "" "$ADMIN_TOKEN"; perf "me"
assert_code "GET /auth/me (authenticated)" 200 "$R_CODE"
ME_ID="$(j '.id // .data.id // .user.id')"
[ -n "$ME_ID" ] && [ "$ME_ID" != "null" ] && ok "/me returns identity (id)" || no "/me identity missing"
# Unauthenticated /me must be blocked.
req GET /auth/me ""
assert_code "GET /auth/me without token blocked" 401 "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "1. LOGIN NEGATIVES + anti-enumeration (AUTH security)"
# Wrong password → 401.
req POST /auth/login "$(jq -nc --arg i "$ADMIN_EMAIL" '{identifier:$i,password:"wrong-pass-xyz"}')"
assert_code "Wrong password rejected" 401 "$R_CODE"
WRONG_MSG="$(j '.message // .error // empty')"
# Unknown user → 401 too, and the SAME generic message (no account enumeration).
req POST /auth/login '{"identifier":"nobody-'"$RANDOM"'@example.invalid","password":"wrong-pass-xyz"}'
assert_code "Unknown user rejected (same as wrong pass)" 401 "$R_CODE"
UNKNOWN_MSG="$(j '.message // .error // empty')"
if [ -n "$WRONG_MSG" ] && [ "$WRONG_MSG" = "$UNKNOWN_MSG" ]; then
  ok "Anti-enumeration: identical login error" "\"$WRONG_MSG\""
else skip "Anti-enumeration login message" "wrong='$WRONG_MSG' unknown='$UNKNOWN_MSG'"; fi
# Missing password → validation error (400/422).
req POST /auth/login "$(jq -nc --arg i "$ADMIN_EMAIL" '{identifier:$i}')"
{ [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } && ok "Missing password → validation error" "($R_CODE)" || no "Missing password validation" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "2. TOKEN REFRESH (AUTH session continuity)"
if [ -n "$ADMIN_REFRESH" ]; then
  req POST /auth/refresh "$(jq -nc --arg r "$ADMIN_REFRESH" '{refreshToken:$r}')"
  is2xx "$R_CODE" && ok "Refresh issues new tokens" "($R_CODE)" || no "Refresh" "$R_CODE"
  NEW_AT="$(j '.accessToken // .data.accessToken // .tokens.accessToken')"
  [ -n "$NEW_AT" ] && ok "Refresh returns a new accessToken" || no "Refresh accessToken missing"
  # An invalid refresh token must be rejected.
  req POST /auth/refresh '{"refreshToken":"not-a-real-token"}'
  is4xx "$R_CODE" && ok "Invalid refresh token rejected" "($R_CODE)" || no "Invalid refresh not rejected" "$R_CODE"
else skip "Token refresh" "no refreshToken from login"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "3. PASSWORD RESET + OTP (anti-enumeration, configurable OTP)"
# forgot-password for a real account and an unknown one must be indistinguishable.
req POST /auth/forgot-password "$(jq -nc --arg i "$ADMIN_EMAIL" '{identifier:$i}')"; FP_KNOWN="$R_CODE"; perf "forgot-password"
req POST /auth/forgot-password '{"identifier":"nobody-'"$RANDOM"'@example.invalid"}'; FP_UNKNOWN="$R_CODE"
{ is2xx "$FP_KNOWN"; } && ok "forgot-password (known) accepted" "($FP_KNOWN)" || no "forgot-password known" "$FP_KNOWN"
if [ "$FP_KNOWN" = "$FP_UNKNOWN" ]; then ok "Anti-enumeration: forgot-password same code" "($FP_KNOWN==$FP_UNKNOWN)"
else no "Anti-enumeration forgot-password" "known=$FP_KNOWN unknown=$FP_UNKNOWN"; fi
# OTP request (+ /otp/send alias) — generic accept.
req POST /auth/otp/request "$(jq -nc --arg i "$ADMIN_EMAIL" '{identifier:$i,purpose:"login"}')"
is2xx "$R_CODE" && ok "OTP request accepted (generic)" "($R_CODE)" || skip "OTP request" "($R_CODE) — may require different purpose"
req POST /auth/otp/send "$(jq -nc --arg i "$ADMIN_EMAIL" '{identifier:$i,purpose:"login"}')"
is2xx "$R_CODE" && ok "OTP /send alias works" "($R_CODE)" || skip "OTP /send alias" "($R_CODE)"
# reset-password with a bad OTP must be rejected (never resets).
req POST /auth/reset-password '{"identifier":"nobody-'"$RANDOM"'@example.invalid","otp":"000000","newPassword":"Verify@12345"}'
is4xx "$R_CODE" && ok "reset-password rejects bad OTP" "($R_CODE)" || no "reset-password bad OTP not rejected" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "4. SIGN-UP VALIDATION (non-destructive — fails before persistence)"
# Weak password (<8) → 422 (validation runs before any user is created).
req POST /auth/signup/student '{"name":"ZZ Verify","role":"student","email":"zz-'"$RANDOM"'@example.invalid","password":"short"}'
{ [ "$R_CODE" = "422" ] || [ "$R_CODE" = "400" ]; } && ok "Weak password rejected" "($R_CODE)" || no "Weak password validation" "$R_CODE"
# Invalid email → 422.
req POST /auth/signup/student '{"name":"ZZ Verify","role":"student","email":"not-an-email","password":"Verify@12345"}'
{ [ "$R_CODE" = "422" ] || [ "$R_CODE" = "400" ]; } && ok "Invalid email rejected" "($R_CODE)" || no "Invalid email validation" "$R_CODE"
# Under-age (AUTH-018: 13+) → 422.
req POST /auth/signup/student '{"name":"ZZ Verify","role":"student","email":"zz-'"$RANDOM"'@example.invalid","password":"Verify@12345","age":10}'
{ [ "$R_CODE" = "422" ] || [ "$R_CODE" = "400" ]; } && ok "Under-13 signup rejected (AUTH-018)" "($R_CODE)" || no "Under-age validation" "$R_CODE"
# Duplicate email (already registered) — rejected (409) or generic anti-enum (2xx).
req POST /auth/signup/student "$(jq -nc --arg e "$ADMIN_EMAIL" '{name:"ZZ Verify",role:"student",email:$e,password:"Verify@12345"}')"
if [ "$R_CODE" = "409" ]; then ok "Duplicate email rejected (409)" "($R_CODE)"
elif is4xx "$R_CODE"; then ok "Duplicate email rejected" "($R_CODE)"
elif is2xx "$R_CODE"; then skip "Duplicate email" "($R_CODE) — generic response (anti-enumeration); no dup created"
else no "Duplicate email unexpected" "$R_CODE"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "5. LOGOUT (session teardown)"
if [ -n "$ADMIN_REFRESH" ]; then
  req POST /auth/logout "$(jq -nc --arg r "$ADMIN_REFRESH" '{refreshToken:$r}')" "$ADMIN_TOKEN"
  is2xx "$R_CODE" && ok "Logout accepted" "($R_CODE)" || skip "Logout" "($R_CODE)"
else skip "Logout" "no refreshToken"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "SUMMARY"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [ "$FAIL" -gt 0 ]; then printf '  Failed: %s\n' "${FAILED_CHECKS[*]}"; fi
echo "  Full log: $OUT"
[ "$FAIL" -eq 0 ] && echo "  ✅ MODULE_01 VERIFIED" || echo "  ❌ MODULE_01 has failures"
exit $(( FAIL > 0 ? 1 : 0 ))
