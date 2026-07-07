#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# benchmark-full.sh — FULL backend performance certification run (ADMIN + STUDENT).
#
# Supersedes benchmark-endpoints.sh for baseline comparisons: that script hit
# /meals and /meals/today WITHOUT groupId, so those rows measured the EMPTY
# early-return path (9–18ms) instead of the real data path. This script logs in
# as BOTH roles, auto-discovers a real groupId per role, and benchmarks every
# hot endpoint on its real, parameterized path. Any non-2xx row is marked
# CHECK! — an error/empty path is never silently reported as a fast endpoint.
#
# Run ON the VPS (isolates backend compute; no client network in the path):
#
#   ADMIN_EMAIL='admin@x.com'   ADMIN_PASS='...' \
#   STUDENT_EMAIL='studnt@x.com' STUDENT_PASS='...' \
#   bash deploy/benchmark-full.sh
#
# Optional env:
#   BASE     (default http://localhost:3000/api/v1)
#   SAMPLES  (default 20 — enough for a meaningful p95)
#   WARMUPS  (default 1 unmeasured request per endpoint; set 0 to include cold)
#   GROUP_ID (skip discovery, force a group)
#   FROM/TO  (default last 7 days / today)
#
# NOTE: /auth/login is throttled 10/min/IP — the script performs exactly 2
# logins. LoginDto accepts ONLY {identifier,password} (extra keys → 422).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
SAMPLES="${SAMPLES:-20}"
WARMUPS="${WARMUPS:-1}"
FROM="${FROM:-$(date -d '-7 days' +%F 2>/dev/null || date +%F)}"
TO="${TO:-$(date +%F)}"

command -v jq >/dev/null 2>&1 || { echo "jq is required (apt install jq)"; exit 1; }
[ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASS:-}" ] || { echo "Set ADMIN_EMAIL / ADMIN_PASS"; exit 1; }
[ -n "${STUDENT_EMAIL:-}" ] && [ -n "${STUDENT_PASS:-}" ] || { echo "Set STUDENT_EMAIL / STUDENT_PASS"; exit 1; }

login() { # $1=email $2=pass → prints accessToken or empty
  curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"identifier\":\"$1\",\"password\":\"$2\"}" | jq -r '.accessToken // empty'
}

echo "── Logging in (2 requests) ──"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASS")"
STUDENT_TOKEN="$(login "$STUDENT_EMAIL" "$STUDENT_PASS")"
[ -n "$ADMIN_TOKEN" ]   || { echo "Admin login FAILED — check credentials"; exit 1; }
[ -n "$STUDENT_TOKEN" ] || { echo "Student login FAILED — check credentials"; exit 1; }
echo "   admin ✓   student ✓"

# ── Discover a real groupId per role (the fix for the empty-path gotcha) ────
discover_group() { # $1=token → first visible group id
  curl -s -H "Authorization: Bearer $1" "$BASE/groups?page=1&limit=5" \
    | jq -r '.data[0].id // empty'
}
AGID="${GROUP_ID:-$(discover_group "$ADMIN_TOKEN")}"
SGID="${GROUP_ID:-$(discover_group "$STUDENT_TOKEN")}"
[ -n "$AGID" ] || { echo "No admin-visible group found — set GROUP_ID"; exit 1; }
[ -n "$SGID" ] || SGID="$AGID"
echo "   admin groupId=$AGID   student groupId=$SGID"
echo

# ── Bench engine ─────────────────────────────────────────────────────────────
FAILED=0; WARNED=0; ROWS=0
hdr() {
  echo
  echo "── $1 ──"
  printf "%-52s %-5s %6s %6s %6s %6s %6s  %s\n" endpoint code min avg p95 max SLO verdict
  printf '%.0s─' {1..104}; echo
}
bench() { # $1=path $2=token(''=unauth) $3=slo_ms $4=expected_code(default 200)
  local path="$1" token="$2" slo="$3" expect="${4:-200}"
  local auth=() times=() code=000 out t ms i
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  for ((i=0; i<WARMUPS; i++)); do
    curl -s -o /dev/null "${auth[@]}" "$BASE$path" >/dev/null 2>&1
  done
  for ((i=0; i<SAMPLES; i++)); do
    out=$(curl -s -o /dev/null -w "%{http_code} %{time_starttransfer}" "${auth[@]}" "$BASE$path")
    code="${out%% *}"; t="${out##* }"
    ms=$(awk "BEGIN{printf \"%.0f\", $t*1000}")
    times+=("$ms")
  done
  # min / avg / p95 / max
  local sorted stats
  sorted=$(printf '%s\n' "${times[@]}" | sort -n)
  stats=$(printf '%s\n' "$sorted" | awk -v n="$SAMPLES" '
    { a[NR]=$1; sum+=$1 }
    END {
      p=int(0.95*n+0.999); if (p<1) p=1; if (p>n) p=n;
      printf "%d %d %d %d", a[1], sum/n, a[p], a[n]
    }')
  read -r mn av p95 mx <<< "$stats"
  local verdict="PASS"
  if [ "$code" != "$expect" ]; then verdict="CHECK! ($code≠$expect)"; FAILED=$((FAILED+1));
  elif [ "$p95" -gt "$slo" ]; then verdict="SLOW p95>${slo}ms"; WARNED=$((WARNED+1)); fi
  ROWS=$((ROWS+1))
  printf "%-52s %-5s %6s %6s %6s %6s %6s  %s\n" "${path%%\?*}" "$code" "$mn" "$av" "$p95" "$mx" "$slo" "$verdict"
}

# SLO budgets (localhost backend-compute, warm): golden-band values from the
# certified baseline (Handbook PART 15) with headroom; composite endpoints get
# composite budgets. A SLOW verdict = investigate, not necessarily a defect.

hdr "BASELINE / SECURITY"
bench "/health"          ""             30
bench "/dashboard/admin" ""             30 401   # unauth rejection speed

hdr "ADMIN — $ADMIN_EMAIL"
T="$ADMIN_TOKEN"
bench "/dashboard/admin"                                            "$T" 60
bench "/dashboard/admin/overview?date=$TO"                          "$T" 400
bench "/groups?page=1&limit=20"                                     "$T" 60
bench "/groups/$AGID"                                               "$T" 60
bench "/groups/$AGID/members?page=1&limit=50"                       "$T" 80
bench "/groups/$AGID/meal-config"                                   "$T" 60
bench "/groups/limits"                                              "$T" 40
bench "/meals?groupId=$AGID"                                        "$T" 120
bench "/meals/today?groupId=$AGID"                                  "$T" 250
bench "/attendance?groupId=$AGID&date=$TO"                          "$T" 60
bench "/attendance/meal-summary?groupId=$AGID&date=$TO"             "$T" 80
bench "/attendance/vacation-members?groupId=$AGID&date=$TO"         "$T" 80
bench "/attendance/billing-summary?groupId=$AGID"                   "$T" 120
bench "/attendance/billing-series?groupId=$AGID&fromDate=$FROM&toDate=$TO" "$T" 120
bench "/reports/analytics?fromDate=$FROM&toDate=$TO"                "$T" 120
bench "/notices?page=1&limit=20"                                    "$T" 60
bench "/notices/unread-count"                                       "$T" 40
bench "/schedules?groupId=$AGID"                                    "$T" 80
bench "/exports/attendance?fromDate=$FROM&toDate=$TO"               "$T" 300

hdr "STUDENT — $STUDENT_EMAIL"
T="$STUDENT_TOKEN"
bench "/dashboard/student"                                          "$T" 60
bench "/users/me"                                                   "$T" 40
bench "/groups?page=1&limit=20"                                     "$T" 60
bench "/groups/my-join-requests"                                    "$T" 60
bench "/meals/today?groupId=$SGID"                                  "$T" 250
bench "/attendance/today"                                           "$T" 60
bench "/attendance/history?fromDate=$FROM&toDate=$TO"               "$T" 60
bench "/attendance/weekly-summary"                                  "$T" 60
bench "/attendance/my-billing?groupId=$SGID"                        "$T" 120
bench "/notices?page=1&limit=20"                                    "$T" 60
bench "/notices/unread-count"                                       "$T" 40

# ── System snapshot (best-effort; each block skipped if tooling absent) ─────
echo
echo "── SYSTEM SNAPSHOT ──"
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | jq -r '.[] | "  pm2 \(.name)[\(.pm_id)] mem=\((.monit.memory/1048576)|floor)MB cpu=\(.monit.cpu)% restarts=\(.pm2_env.restart_time) unstable=\(.pm2_env.unstable_restarts)"' || true
fi
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^emeal_postgres$'; then
  docker exec emeal_postgres bash -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT '\''  pg cache_hit='\''||round(100*sum(blks_hit)::numeric/nullif(sum(blks_hit)+sum(blks_read),0),2)||'\''% db_size='\''||pg_size_pretty(pg_database_size(current_database())) FROM pg_stat_database WHERE datname=current_database();"' 2>/dev/null || true
fi
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^emeal_redis$'; then
  docker exec emeal_redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO 2>/dev/null | grep -E "used_memory_human|keyspace_hits|keyspace_misses|evicted_keys" | sed "s/^/  redis /"' 2>/dev/null || true
fi
free -m 2>/dev/null | awk 'NR==2{printf "  ram used=%sMB / %sMB\n", $3, $2}' || true

# ── Verdict ──────────────────────────────────────────────────────────────────
echo
echo "── RESULT ──"
echo "  rows=$ROWS  non-2xx(CHECK!)=$FAILED  slo-breaches(SLOW)=$WARNED"
if [ "$FAILED" -gt 0 ]; then
  echo "  ✗ $FAILED endpoint(s) did not return the expected status — those timings"
  echo "    are NOT valid perf evidence. Fix params/permissions and re-run."
  exit 2
elif [ "$WARNED" -gt 0 ]; then
  echo "  ⚠ All endpoints healthy; $WARNED exceeded their p95 budget — compare with"
  echo "    docs/SERVER_HANDBOOK.md PART 15 golden bands before calling regression."
  exit 1
else
  echo "  ✓ ALL endpoints healthy AND within p95 budgets — golden baseline holds."
fi
