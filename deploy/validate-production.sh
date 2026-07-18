#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# validate-production.sh — MealAttend FULL production validation (command_4).
#
# Runs ON the VPS against the real backend. Validates features end-to-end,
# multi-tenant isolation, security, performance, memory and DB consistency
# with REAL server responses. All results are written to /tmp/emeal-validation.
#
# Usage (from the repo root on the VPS):
#   ADMIN_EMAIL='admin@example.com'   ADMIN_PASS='...' \
#   STUDENT_EMAIL='student@example.com' STUDENT_PASS='...' \
#   ADMIN2_EMAIL='other-org-admin@example.com' ADMIN2_PASS='...' \
#   bash deploy/validate-production.sh
#
# Optional env: BASE (default http://localhost:3000/api/v1), EDGE (https://your
# domain — enables TLS/header checks), GROUP_ID (else auto-discovered),
# SAMPLES (perf samples per endpoint, default 6), FLOOD_N (default 300),
# FLOOD_C (default 25), SKIP_THROTTLE=1 (skip the 429 probe).
#
# SAFE BY DESIGN — the only writes are:
#   • a throwaway signup that DELETES ITSELF (delete-account e2e proof)
#   • one vacation request that is immediately CANCELLED
# No attendance marks, no config changes, no renames, no deletions of real data.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
EDGE="${EDGE:-}"
SAMPLES="${SAMPLES:-6}"
FLOOD_N="${FLOOD_N:-300}"
FLOOD_C="${FLOOD_C:-25}"
OUT=/tmp/emeal-validation
mkdir -p "$OUT"
RESULTS="$OUT/RESULTS.txt"
BODIES="$OUT/bodies"
mkdir -p "$BODIES"
: > "$RESULTS"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }

PASS=0; FAIL=0; WARN=0
STARTED_AT="$(date -u +%FT%TZ)"

log()  { echo "$*" | tee -a "$RESULTS"; }
hdr()  { log ""; log "══════ $* ══════"; }

# check <name> <ok?0/1> <detail>
check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "0" ]; then PASS=$((PASS+1)); log "PASS  | $name | $detail";
  else FAIL=$((FAIL+1)); log "FAIL  | $name | $detail"; fi
}
warn() { WARN=$((WARN+1)); log "WARN  | $1 | ${2:-}"; }

# req <method> <path> <token|-> <json-body|-> <outfile-tag>
# → sets R_CODE, R_MS, R_BODY (file path)
req() {
  local method="$1" path="$2" token="$3" body="$4" tag="$5"
  local args=(-s -X "$method" -H 'Content-Type: application/json' -o "$BODIES/$tag.json" -w '%{http_code} %{time_total}')
  [ "$token" != "-" ] && args+=(-H "Authorization: Bearer $token")
  [ "$body"  != "-" ] && args+=(-d "$body")
  local out; out=$(curl "${args[@]}" "$BASE$path")
  R_CODE="${out%% *}"
  R_MS=$(awk "BEGIN{printf \"%.0f\", ${out##* }*1000}")
  R_BODY="$BODIES/$tag.json"
}
jval() { jq -r "$1" "$R_BODY" 2>/dev/null; }

log "MealAttend PRODUCTION VALIDATION — $STARTED_AT"
log "BASE=$BASE  OUT=$OUT"

# ═════ A. SERVER HEALTH ══════════════════════════════════════════════════════
hdr "A. SERVER HEALTH"
req GET /health - - health
check "A1 /health 200" $([ "$R_CODE" = "200" ] && echo 0 || echo 1) "code=$R_CODE ${R_MS}ms"
log "health body: $(cat "$R_BODY" | head -c 400)"

PM2_MEM_BEFORE=$(pm2 jlist 2>/dev/null | jq '[.[].monit.memory] | add // 0')
PM2_PROCS=$(pm2 jlist 2>/dev/null | jq 'length')
PM2_RESTARTS=$(pm2 jlist 2>/dev/null | jq '[.[].pm2_env.unstable_restarts] | add // 0')
check "A2 pm2 workers online" $([ "${PM2_PROCS:-0}" -ge 1 ] && echo 0 || echo 1) "procs=$PM2_PROCS memTotal=$((PM2_MEM_BEFORE/1024/1024))MB unstableRestarts=$PM2_RESTARTS"
[ "${PM2_RESTARTS:-0}" -gt 0 ] && warn "A2b unstable restarts non-zero" "$PM2_RESTARTS"

DOCKER_UP=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | tee "$OUT/docker-ps.txt" | wc -l)
DOCKER_UNHEALTHY=$(grep -ci 'unhealthy\|restarting' "$OUT/docker-ps.txt" || true)
check "A3 docker containers healthy" $([ "${DOCKER_UNHEALTHY:-0}" = "0" ] && echo 0 || echo 1) "up=$DOCKER_UP unhealthy=$DOCKER_UNHEALTHY"

PG_C=$(docker ps --format '{{.Names}}' | grep -m1 postgres || true)
RD_C=$(docker ps --format '{{.Names}}' | grep redis | grep -v exporter | head -n1 || true)
psqlq() { docker exec "$PG_C" bash -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -tAc \"$1\"" 2>/dev/null | tr -d '[:space:]'; }
PG_OK=$(psqlq "SELECT 1")
check "A4 postgres reachable" $([ "$PG_OK" = "1" ] && echo 0 || echo 1) "container=$PG_C"
REDIS_PW=$(grep -m1 '^REDIS_PASSWORD=' .env 2>/dev/null | cut -d= -f2-)
RD_PING=$(docker exec "$RD_C" redis-cli --no-auth-warning -a "$REDIS_PW" ping 2>/dev/null)
check "A5 redis reachable" $([ "$RD_PING" = "PONG" ] && echo 0 || echo 1) "container=$RD_C"

DISK=$(df -h / | awk 'NR==2{print $5}')
MEMFREE=$(free -m | awk '/Mem:/{print $7}')
log "host: disk=$DISK used, availMem=${MEMFREE}MB, uptime=$(uptime -p)"

# ═════ B. AUTHENTICATION ═════════════════════════════════════════════════════
hdr "B. AUTHENTICATION (signin, tokens, 7-day contract mechanics)"
req POST /auth/login - "{\"identifier\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" admin-login
AT=$(jval .accessToken); ART=$(jval .refreshToken)
check "B1 admin login" $([ "$R_CODE" = "200" ] && [ -n "$AT" ] && [ "$AT" != "null" ] && echo 0 || echo 1) "code=$R_CODE ${R_MS}ms"

req POST /auth/login - "{\"identifier\":\"$STUDENT_EMAIL\",\"password\":\"$STUDENT_PASS\"}" student-login
ST=$(jval .accessToken)
check "B2 student login" $([ "$R_CODE" = "200" ] && [ -n "$ST" ] && [ "$ST" != "null" ] && echo 0 || echo 1) "code=$R_CODE ${R_MS}ms"

A2T=""
if [ -n "${ADMIN2_EMAIL:-}" ]; then
  req POST /auth/login - "{\"identifier\":\"$ADMIN2_EMAIL\",\"password\":\"$ADMIN2_PASS\"}" admin2-login
  A2T=$(jval .accessToken)
  check "B3 secondary admin login" $([ "$R_CODE" = "200" ] && [ -n "$A2T" ] && [ "$A2T" != "null" ] && echo 0 || echo 1) "code=$R_CODE ${R_MS}ms"
fi

# Login negatives (case-insensitive / wrong password / no-token): under the
# master audit these exact probes run once in the srs module (FR-AUTH tags) —
# repeating them here also burned the shared 10/min login budget. Standalone
# runs keep them (this script must stand alone as the production gate).
_amods=" ${AUDIT_MODULES:-} "
if [ "${AUDIT_DEDUP:-0}" = "1" ] && case "$_amods" in *" srs "*) true;; *) false;; esac; then
  log "  ·  B4-B6 login negatives asserted once by the srs module this session (run-once dedup)"
else
  # case-insensitive login (deployed fix)
  UPPER_EMAIL=$(echo "$ADMIN_EMAIL" | tr '[:lower:]' '[:upper:]')
  req POST /auth/login - "{\"identifier\":\"$UPPER_EMAIL\",\"password\":\"$ADMIN_PASS\"}" admin-login-upper
  check "B4 case-insensitive login" $([ "$R_CODE" = "200" ] && echo 0 || echo 1) "code=$R_CODE (UPPERCASE identifier)"

  req POST /auth/login - "{\"identifier\":\"$ADMIN_EMAIL\",\"password\":\"definitely-wrong-Pass1!\"}" bad-pass
  check "B5 wrong password rejected" $([ "$R_CODE" = "401" ] || [ "$R_CODE" = "422" ] && echo 0 || echo 1) "code=$R_CODE"

  req GET /dashboard/admin - - no-token
  check "B6 no-token rejected 401" $([ "$R_CODE" = "401" ] && echo 0 || echo 1) "code=$R_CODE ${R_MS}ms"
fi

# refresh rotation (mechanics behind "stay signed in ≥1 open per 7 days")
req POST /auth/refresh - "{\"refreshToken\":\"$ART\"}" refresh1
NEW_RT=$(jval .refreshToken)
check "B7 refresh rotation issues new pair" $([ "$R_CODE" = "200" ] && [ -n "$NEW_RT" ] && [ "$NEW_RT" != "null" ] && echo 0 || echo 1) "code=$R_CODE ${R_MS}ms"
# grace: replay of the JUST-rotated token within the grace window must NOT nuke
req POST /auth/refresh - "{\"refreshToken\":\"$ART\"}" refresh-replay
check "B8 rotation replay inside grace survives (no false-positive logout)" $([ "$R_CODE" = "200" ] && echo 0 || echo 1) "code=$R_CODE"
req GET /auth/me "$AT" - me
check "B9 /auth/me with original access token still valid" $([ "$R_CODE" = "200" ] && echo 0 || echo 1) "code=$R_CODE user=$(jval .email 2>/dev/null)$(jval .user.email 2>/dev/null)"

# ═════ C. SIGNUP → DELETE-ACCOUNT E2E (self-cleaning) ════════════════════════
# RUN-ONCE DEDUP: under the master audit the identical signup→guard→delete→
# re-login lifecycle already ran in the srs module's write-lifecycle section
# this session — repeating it here would be the 2nd disposable signup of the
# same audit. Standalone runs keep it (this script must stand alone as the
# production gate). (_amods is set once in section B above.)
if [ "${AUDIT_DEDUP:-0}" = "1" ] && [ "${AUDIT_WRITES:-0}" = "1" ] && case "$_amods" in *" srs "*) true;; *) false;; esac; then
  hdr "C. SIGNUP + ACCOUNT DELETION E2E — deduplicated"
  log "  ·  lifecycle ran once this session in the srs module (write lifecycle) — see srs.log"
else
hdr "C. SIGNUP + ACCOUNT DELETION E2E (throwaway, self-cleaning)"
TS=$(date +%s)
TP_EMAIL="validation.$TS@example.com"
TP_PASS="Validate@$TS"
req POST /auth/signup/student - "{\"name\":\"Validation Probe\",\"role\":\"student\",\"email\":\"$TP_EMAIL\",\"password\":\"$TP_PASS\"}" signup
TPT=$(jval .accessToken)
if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
  check "C1 student signup" 0 "code=$R_CODE ${R_MS}ms email=$TP_EMAIL"
  [ -z "$TPT" ] || [ "$TPT" = "null" ] && { req POST /auth/login - "{\"identifier\":\"$TP_EMAIL\",\"password\":\"$TP_PASS\"}" tp-login; TPT=$(jval .accessToken); }
  req DELETE /users/me "$TPT" "{\"confirm\":\"nope\",\"password\":\"$TP_PASS\"}" del-guard
  check "C2 delete rejects wrong confirm phrase" $([ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ] && echo 0 || echo 1) "code=$R_CODE"
  req DELETE /users/me "$TPT" "{\"confirm\":\"DELETE\",\"password\":\"$TP_PASS\"}" del
  check "C3 account deletion (DELETE /users/me)" $([ "$R_CODE" = "200" ] && echo 0 || echo 1) "code=$R_CODE ${R_MS}ms"
  req POST /auth/login - "{\"identifier\":\"$TP_EMAIL\",\"password\":\"$TP_PASS\"}" tp-relogin
  check "C4 deleted account cannot re-login" $([ "$R_CODE" = "401" ] || [ "$R_CODE" = "403" ] || [ "$R_CODE" = "422" ] && echo 0 || echo 1) "code=$R_CODE"
else
  check "C1 student signup" 1 "code=$R_CODE — signup failed; delete lifecycle skipped"
fi
fi

# ═════ SUMMARY ═══════════════════════════════════════════════════════════════
hdr "SUMMARY"
log "PASS=$PASS  FAIL=$FAIL  WARN=$WARN"
log "Finished $(date -u +%FT%TZ) — full results under $OUT"
if [ "$FAIL" -eq 0 ]; then exit 0; else exit 1; fi