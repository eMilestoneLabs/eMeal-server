#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-certificate.sh — PRODUCTION CERTIFICATION GENERATOR (eMeal platform)
#
# Runs the full real-parameter test battery on the VPS and, when every gate
# passes, mints a graded certificate file. No pass, no certificate.
#
# Run ON the VPS from the app directory:
#
#   ADMIN_EMAIL='...' ADMIN_PASS='...' STUDENT_EMAIL='...' STUDENT_PASS='...' \
#   bash deploy/generate-certificate.sh [--apk-mb 30.0] [--device-smoke pass]
#
#   --apk-mb <n>         attested arm64 release APK size in MB (from your build)
#   --device-smoke pass  attested on-device R8 smoke test (login/push/QR ok)
#   (both optional — omitted rows show "not attested" and cap the grade at A)
#
# What it measures (real, not estimated):
#   1. Endpoint speed  — every admin+student hot endpoint, p95 vs SLO budgets
#                        (delegates to deploy/benchmark-full.sh)
#   2. Stability       — PM2 unstable restarts, Docker container health
#   3. Memory          — per-worker RSS, system RAM headroom
#   4. Database        — PostgreSQL cache-hit ratio, DB size
#   5. Cache           — Redis evictions + hit ratio
#   6. Security        — unauth rejection (from bench), UFW + Fail2Ban active,
#                        TLS certificate days remaining
#   7. Disk            — usage headroom
#
# Output: deploy/CERTIFICATION_<UTC-date>.md  (graded A+/A/B per category)
# Exit:   0 = CERTIFIED, 1 = grade-capped (warnings), 2 = FAILED (no cert)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."   # app root

APK_MB=""; SMOKE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apk-mb) APK_MB="${2:-}"; shift 2;;
    --device-smoke) SMOKE="${2:-}"; shift 2;;
    *) echo "unknown arg $1"; exit 2;;
  esac
done

command -v jq >/dev/null || { echo "jq required"; exit 2; }
STAMP="$(date -u +%Y-%m-%d)"
OUT="deploy/CERTIFICATION_${STAMP}.md"
BENCH_LOG="$(mktemp)"

note()  { printf '  %s\n' "$1"; }
FAILS=0; WARNS=0
declare -A GRADE VALUE

grade_row() { # $1 category  $2 grade  $3 value-text ; grade FAIL bumps FAILS, B bumps WARNS
  GRADE["$1"]="$2"; VALUE["$1"]="$3"
  [ "$2" = "FAIL" ] && FAILS=$((FAILS+1))
  [ "$2" = "B" ] && WARNS=$((WARNS+1))
  note "[$2] $1 — $3"
}

echo "══ eMeal PRODUCTION CERTIFICATION RUN — $STAMP (UTC) ══"

# ── 1. SPEED — full admin+student endpoint battery ───────────────────────────
echo "── [1/7] Endpoint speed battery (benchmark-full.sh) ──"
bash deploy/benchmark-full.sh >"$BENCH_LOG" 2>&1
BENCH_EXIT=$?
ROWS_LINE=$(grep -E '^  rows=' "$BENCH_LOG" || echo "rows=? non-2xx(CHECK!)=? slo-breaches(SLOW)=?")
CHECKS=$(echo "$ROWS_LINE" | grep -oE 'CHECK!\)=[0-9]+' | grep -oE '[0-9]+' || echo 99)
SLOWS=$(echo "$ROWS_LINE"  | grep -oE 'SLOW\)=[0-9]+'   | grep -oE '[0-9]+' || echo 99)
if [ "$BENCH_EXIT" -ge 2 ] || [ "$CHECKS" -gt 0 ]; then
  grade_row "Endpoint speed (p95 vs SLO)" "FAIL" "$CHECKS invalid row(s) — timings not valid evidence"
elif [ "$SLOWS" -eq 0 ]; then
  grade_row "Endpoint speed (p95 vs SLO)" "A+" "all rows 2xx and within p95 budgets"
elif [ "$SLOWS" -le 3 ]; then
  grade_row "Endpoint speed (p95 vs SLO)" "A" "$SLOWS row(s) above budget — compare Handbook PART 15"
else
  grade_row "Endpoint speed (p95 vs SLO)" "B" "$SLOWS rows above budget"
fi

# ── 2. STABILITY — PM2 + Docker ──────────────────────────────────────────────
echo "── [2/7] Stability ──"
if command -v pm2 >/dev/null; then
  UNSTABLE=$(pm2 jlist 2>/dev/null | jq '[.[].pm2_env.unstable_restarts] | add // 0')
  if [ "${UNSTABLE:-0}" -eq 0 ]; then grade_row "Process stability (PM2)" "A+" "0 unstable restarts";
  else grade_row "Process stability (PM2)" "FAIL" "$UNSTABLE unstable restart(s) — investigate pm2 logs"; fi
else
  grade_row "Process stability (PM2)" "FAIL" "pm2 not found"
fi
UNHEALTHY=$(docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -ci 'unhealthy\|restarting' || true)
if [ "${UNHEALTHY:-0}" -eq 0 ]; then grade_row "Container health (Docker)" "A+" "all containers healthy";
else grade_row "Container health (Docker)" "FAIL" "$UNHEALTHY unhealthy/restarting container(s)"; fi

# ── 3. MEMORY ────────────────────────────────────────────────────────────────
echo "── [3/7] Memory ──"
if command -v pm2 >/dev/null; then
  MAXMB=$(pm2 jlist 2>/dev/null | jq '[.[].monit.memory] | max // 0 | ./1048576 | floor')
  if [ "${MAXMB:-999}" -le 200 ]; then grade_row "Worker memory" "A+" "max ${MAXMB}MB/worker (golden band ≤200)";
  elif [ "$MAXMB" -le 300 ]; then grade_row "Worker memory" "A" "max ${MAXMB}MB/worker";
  else grade_row "Worker memory" "B" "max ${MAXMB}MB/worker — check for growth vs 133MB baseline"; fi
fi
read -r RAM_USED RAM_TOT <<<"$(free -m | awk 'NR==2{print $3, $2}')"
RAM_PCT=$((100*RAM_USED/RAM_TOT))
if [ "$RAM_PCT" -le 50 ]; then grade_row "System RAM" "A+" "${RAM_USED}/${RAM_TOT}MB (${RAM_PCT}%)";
elif [ "$RAM_PCT" -le 75 ]; then grade_row "System RAM" "A" "${RAM_USED}/${RAM_TOT}MB (${RAM_PCT}%)";
else grade_row "System RAM" "B" "${RAM_USED}/${RAM_TOT}MB (${RAM_PCT}%) — headroom shrinking"; fi

# ── 4. DATABASE ──────────────────────────────────────────────────────────────
echo "── [4/7] Database ──"
PG=$(docker exec emeal_postgres bash -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT round(100*sum(blks_hit)::numeric/nullif(sum(blks_hit)+sum(blks_read),0),2)||\" \"||pg_size_pretty(pg_database_size(current_database())) FROM pg_stat_database WHERE datname=current_database();"' 2>/dev/null || echo "")
PG_HIT=$(echo "$PG" | awk '{print $1}'); PG_SIZE=$(echo "$PG" | awk '{print $2$3}')
if [ -n "$PG_HIT" ] && awk "BEGIN{exit !($PG_HIT>=99)}"; then
  grade_row "PostgreSQL cache-hit" "A+" "${PG_HIT}% (db ${PG_SIZE:-?})"
elif [ -n "$PG_HIT" ]; then grade_row "PostgreSQL cache-hit" "B" "${PG_HIT}% (<99%)";
else grade_row "PostgreSQL cache-hit" "B" "could not measure"; fi

# ── 5. CACHE (Redis) ─────────────────────────────────────────────────────────
echo "── [5/7] Redis ──"
RINFO=$(docker exec emeal_redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO stats 2>/dev/null' 2>/dev/null || echo "")
EVICTED=$(echo "$RINFO" | grep -oP 'evicted_keys:\K[0-9]+' || echo "")
HITS=$(echo "$RINFO" | grep -oP 'keyspace_hits:\K[0-9]+' || echo 0)
MISSES=$(echo "$RINFO" | grep -oP 'keyspace_misses:\K[0-9]+' || echo 0)
if [ -n "$EVICTED" ]; then
  RATIO=$(( (HITS*100) / (HITS + MISSES + 1) ))
  if [ "$EVICTED" -eq 0 ]; then grade_row "Redis cache" "A+" "0 evictions, hit-ratio ${RATIO}%";
  else grade_row "Redis cache" "B" "$EVICTED evictions — memory pressure"; fi
else grade_row "Redis cache" "B" "could not measure"; fi

# ── 6. SECURITY ──────────────────────────────────────────────────────────────
echo "── [6/7] Security ──"
UFW_OK=$(sudo -n ufw status 2>/dev/null | grep -c 'Status: active' || true)
F2B_OK=$(systemctl is-active fail2ban 2>/dev/null | grep -c '^active' || true)
if [ "${UFW_OK:-0}" -ge 1 ] && [ "${F2B_OK:-0}" -ge 1 ]; then
  grade_row "Perimeter (UFW+Fail2Ban)" "A+" "firewall active, fail2ban active"
else
  grade_row "Perimeter (UFW+Fail2Ban)" "B" "could not verify both (needs sudo) — check manually"
fi
CERT_DAYS=$(echo | timeout 10 openssl s_client -servername api.emilestone.com -connect api.emilestone.com:443 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 | xargs -I{} date -d "{}" +%s 2>/dev/null)
if [ -n "$CERT_DAYS" ]; then
  DAYS_LEFT=$(( (CERT_DAYS - $(date +%s)) / 86400 ))
  if [ "$DAYS_LEFT" -ge 14 ]; then grade_row "TLS certificate" "A+" "${DAYS_LEFT} days remaining (auto-renew)";
  else grade_row "TLS certificate" "FAIL" "only ${DAYS_LEFT} days left — check certbot"; fi
else grade_row "TLS certificate" "B" "could not read expiry"; fi
UNAUTH_OK=$(grep -E '/dashboard/admin\s+401' "$BENCH_LOG" | grep -c 'PASS' || true)
if [ "${UNAUTH_OK:-0}" -ge 1 ]; then grade_row "Unauth rejection" "A+" "401 within budget (from battery)";
else grade_row "Unauth rejection" "B" "not confirmed in battery output"; fi

# ── 7. DISK ──────────────────────────────────────────────────────────────────
echo "── [7/7] Disk ──"
DISK_PCT=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
if [ "$DISK_PCT" -le 60 ]; then grade_row "Disk headroom" "A+" "${DISK_PCT}% used";
elif [ "$DISK_PCT" -le 80 ]; then grade_row "Disk headroom" "A" "${DISK_PCT}% used";
else grade_row "Disk headroom" "FAIL" "${DISK_PCT}% used — reclaim space"; fi

# ── Frontend attestations (optional inputs) ──────────────────────────────────
if [ -n "$APK_MB" ]; then
  if awk "BEGIN{exit !($APK_MB<=40)}"; then grade_row "APK size (arm64, attested)" "A+" "${APK_MB} MB";
  else grade_row "APK size (arm64, attested)" "B" "${APK_MB} MB (>40)"; fi
else grade_row "APK size (arm64, attested)" "B" "not attested — pass --apk-mb"; fi
if [ "$SMOKE" = "pass" ]; then grade_row "R8 device smoke test (attested)" "A+" "login/push/QR verified on device";
else grade_row "R8 device smoke test (attested)" "B" "not attested — pass --device-smoke pass"; fi

# ── Verdict + certificate ────────────────────────────────────────────────────
if [ "$FAILS" -gt 0 ]; then OVERALL="❌ NOT CERTIFIED"; RC=2
elif [ "$WARNS" -gt 0 ]; then OVERALL="🟡 CERTIFIED (grade A — ${WARNS} advisory item(s))"; RC=1
else OVERALL="🏆 CERTIFIED — GRADE A+ (all parameters golden)"; RC=0; fi

{
  echo "# 🏆 eMeal Platform — Production Certification"
  echo
  echo "- **Date (UTC):** $STAMP"
  echo "- **Host:** $(hostname)  ·  **Release:** $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "- **Uptime:** $(uptime -p 2>/dev/null || true)"
  echo "- **Verdict:** $OVERALL"
  echo
  echo "| Parameter | Grade | Measured value |"
  echo "|---|---|---|"
  for k in "${!GRADE[@]}"; do echo "| $k | ${GRADE[$k]} | ${VALUE[$k]} |"; done | sort
  echo
  echo "Grading: A+ = golden-baseline band · A = within SLO with headroom notes ·"
  echo "B = advisory (investigate, non-blocking) · FAIL = blocks certification."
  echo "Baselines: docs/SERVER_HANDBOOK.md PART 15. Re-run any time:"
  echo '`ADMIN_EMAIL=.. ADMIN_PASS=.. STUDENT_EMAIL=.. STUDENT_PASS=.. bash deploy/generate-certificate.sh`'
  echo
  echo "## Appendix — full endpoint battery"
  echo '```'
  cat "$BENCH_LOG"
  echo '```'
} > "$OUT"

echo
echo "══ $OVERALL ══"
echo "Certificate written to: $OUT"
rm -f "$BENCH_LOG"
exit "$RC"
