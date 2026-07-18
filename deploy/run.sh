#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run.sh — eMeal MASTER AUDIT ORCHESTRATOR (single entry point for every check)
#
#   bash deploy/run.sh --help          list modules
#   bash deploy/run.sh --all           every READ-ONLY module + master certificate
#   bash deploy/run.sh --benchmark     one module (any name from --help)
#   bash deploy/run.sh --all --writes  also include the self-cleaning WRITE suites
#   bash deploy/run.sh --all --load    also include the k6 EXTREME load test
#   bash deploy/run.sh --all --yes     no prompts (existing test accounts)
#
# PRODUCTION-BASELINE CONTRACT (the golden rule of this file):
#   • This orchestrator and every module it calls are STRICTLY DECOUPLED from
#     the production baseline: they never modify application code, config,
#     infra, nginx, PM2, docker, or the database schema. They only OBSERVE.
#   • Default modules are READ-ONLY (real HTTP GETs + system/db statistics).
#   • Suites that create test data (e2e / production / srs writes) are
#     SELF-CLEANING and run ONLY behind the explicit --writes flag.
#   • The load test is traffic-only (no data change) but heavy — explicit
#     --load flag, run it off-peak.
#
# ACCOUNTS: defaults come from deploy/srs/accounts.sh (2 admins + 2 students,
# env-overridable). The script asks once whether to use them or enter custom
# credentials; --yes skips the prompt (existing accounts).
#
# OUTPUT: every module log lands in deploy/audit-reports/<timestamp>/ and a
# combined MASTER_AUDIT.md certificate aggregates every parameter + verdict.
#
# MAINTENANCE: add a module = ONE `reg` line in the registry below pointing at
# a standalone script (see docs/OPUS_DEVELOPMENT_GUIDEBOOK.md §9 for the rules
# every new audit script must follow).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."                     # app root
ROOT="$PWD"
TS="$(date +%Y%m%d_%H%M%S)"
REPORT_DIR="$ROOT/deploy/audit-reports/$TS"

# ── Module registry ──────────────────────────────────────────────────────────
# reg <name> <impact: RO|WRITE|HEAVY> <description>
MOD_NAMES=(); declare -A MOD_IMPACT MOD_DESC
reg() { MOD_NAMES+=("$1"); MOD_IMPACT["$1"]="$2"; MOD_DESC["$1"]="$3"; }

# ORDER MATTERS: modules that FLOOD login (security's SEC-F, srs's capacity ramp)
# leave the per-IP login throttle (10/min) HOT. Any login-authenticating module
# that runs immediately after gets 429 on its OWN login → empty token → false
# failures. So: light login-free/low-login modules first, and a throttle
# cooldown (COOLDOWN below) is inserted before each login-heavy module. srs runs
# LAST because its capacity ramp is the heaviest flooder.
# diagnose runs FIRST: it samples CPU steal / load / top consumers BEFORE the
# audit adds its own load, so slow numbers later can be attributed correctly.
reg diagnose    RO    "Box-contention snapshot — CPU steal vs local hogs vs app, /health probe (diagnose-slowdown.sh)"
reg benchmark   RO    "Endpoint speed battery — admin+student p95 vs SLO budgets (benchmark-full.sh)"
reg certificate RO    "Graded production certificate — speed+stability+memory+db+redis+security+disk (generate-certificate.sh)"
reg db          RO    "Database deep parameters — cache-hit, connections, index usage, bloat, autovacuum"
# fixtures runs BEFORE every validator: it repairs the STANDING TEST ACCOUNTS
# (email-verification stamp, group membership) and re-applies clean-data UNIQUE
# indexes, so validators reach the real validation paths instead of the
# account gate (the 403/SKIP class audit 8295988 exposed). Test-fixture scope
# only — real member data is never touched.
reg fixtures    WRITE "Test-fixture doctor — verifies standing test accounts (ACC-005), ensures student group membership, re-applies clean-data UNI indexes (ensure-test-fixtures.sh)"
reg unidoctor   RO    "UNI race-proof index doctor — names missing UNIQUE indexes + the exact duplicate rows blocking them (uni-index-doctor.sh; diagnosis-only — row-level dedupe stays a manual operational step; clean-data DDL re-apply is automated via the fixtures module)"
reg system      RO    "System health — CPU, RAM, disk, PM2, docker, logs, TLS, uptime"
reg recovery    RO    "Auto-recovery configuration audit (verify-auto-recovery.sh)"
reg security    RO    "Security / pen-test probes — auth, isolation, injection, headers (srs/security.sh)"
reg srs         RO    "SRS requirement validation — functional+security+performance vs the 664-req manifest (srs/run.sh; read-only unless --writes)"
reg e2e         WRITE "Full feature end-to-end with SELF-CLEANING test writes (validate-e2e.sh)"
reg mealcheck   WRITE "MODULE-03 Meal/Attendance/Billing SRS validation, self-cleaning (validate-meal-attendance-billing.sh)"
reg production  WRITE "Full production validation incl. tenant-isolation writes (validate-production.sh)"
reg load        HEAVY "EXTREME load / peak-hours simulation — k6 high-concurrency against localhost (loadtest.js)"
# checklist stays LAST in the registry: it grades THIS run's module logs, so
# every module selected above must have finished (and written its log) first.
reg checklist   RO    "190-parameter enterprise checklist — evidence-graded from this run's logs + live probes (checklist-190.sh)"
# NOT registered here (deliberately — they are OPERATIONAL, not observational,
# and the baseline contract above says audits never modify anything):
#   deploy.sh · backup.sh · backfill-email-verified.sh (runs inside deploy.sh)
#   rotate-secrets.sh · harden-server.sh · setup-vps.sh · reset-for-launch.sh
#   dr-drill.sh · minio-reconcile.sh · enable-pg-stat-statements.sh

usage() {
  echo "Usage: bash deploy/run.sh [--all] [--<module> ...] [--writes] [--load] [--yes] [--help]"
  echo
  echo "Modules:"
  for m in "${MOD_NAMES[@]}"; do
    printf "  --%-12s [%-5s] %s\n" "$m" "${MOD_IMPACT[$m]}" "${MOD_DESC[$m]}"
  done
  echo
  echo "  --all     = every RO module (+WRITE with --writes, +HEAVY with --load)"
  echo "  --yes     = non-interactive: use existing test accounts, no prompts"
  echo "  RO=read-only  WRITE=self-cleaning test writes  HEAVY=load traffic"
  echo
  echo "Zero production impact: see the PRODUCTION-BASELINE CONTRACT in this file."
}

# ── Flag parsing ─────────────────────────────────────────────────────────────
SELECTED=(); ALL=0; WRITES=0; LOAD=0; YES=0
[ $# -eq 0 ] && { usage; exit 0; }
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0;;
    --all) ALL=1;;
    --writes) WRITES=1;;
    --load) LOAD=1;;
    --yes|-y) YES=1;;
    --*)
      name="${1#--}"
      if [ -n "${MOD_DESC[$name]:-}" ]; then SELECTED+=("$name");
      else echo "Unknown module: $1 (see --help)"; exit 2; fi;;
    *) echo "Unknown arg: $1"; exit 2;;
  esac
  shift
done
if [ "$ALL" -eq 1 ]; then
  for m in "${MOD_NAMES[@]}"; do
    case "${MOD_IMPACT[$m]}" in
      RO) SELECTED+=("$m");;
      WRITE) [ "$WRITES" -eq 1 ] && SELECTED+=("$m");;
      HEAVY) [ "$LOAD" -eq 1 ] && SELECTED+=("$m");;
    esac
  done
elif [ "$LOAD" -eq 1 ]; then
  # `bash deploy/run.sh --load` alone = run just the load module.
  SELECTED+=(load)
fi
[ ${#SELECTED[@]} -gt 0 ] || { echo "Nothing selected."; usage; exit 2; }
# Explicit single-module WRITE/HEAVY selection is allowed but must confirm.
for m in "${SELECTED[@]}"; do
  if [ "${MOD_IMPACT[$m]}" != "RO" ] && [ "$YES" -ne 1 ]; then
    read -r -p "⚠  '$m' is ${MOD_IMPACT[$m]} (test writes / heavy traffic). Continue? [y/N] " a
    [[ "$a" =~ ^[Yy]$ ]] || { echo "Skipping $m."; SELECTED=("${SELECTED[@]/$m}"); }
  fi
done

# ── Accounts ─────────────────────────────────────────────────────────────────
# Defaults: deploy/srs/accounts.sh (2 admins + 2 students, env-overridable).
if [ "$YES" -ne 1 ]; then
  read -r -p "Use EXISTING test accounts from deploy/srs/accounts.sh? [Y/n] " a
  if [[ "$a" =~ ^[Nn]$ ]]; then
    read -r -p "  Admin email: "    ADMIN_EMAIL;   export ADMIN_EMAIL
    read -r -s -p "  Admin password: " ADMIN_PASS; echo; export ADMIN_PASS
    read -r -p "  Student email: "  STUDENT_EMAIL; export STUDENT_EMAIL
    read -r -s -p "  Student password: " STUDENT_PASS; echo; export STUDENT_PASS
    read -r -p "  2nd admin email (blank=skip cross-org probes): " ADMIN2_EMAIL || true
    [ -n "${ADMIN2_EMAIL:-}" ] && { export ADMIN2_EMAIL; read -r -s -p "  2nd admin password: " ADMIN2_PASS; echo; export ADMIN2_PASS; }
    read -r -p "  2nd student email (blank=skip cross-user probes): " STUDENT2_EMAIL || true
    [ -n "${STUDENT2_EMAIL:-}" ] && { export STUDENT2_EMAIL; read -r -s -p "  2nd student password: " STUDENT2_PASS; echo; export STUDENT2_PASS; }
  fi
fi
# shellcheck disable=SC1091 — fills any unset slot with the standing test accounts.
source "$ROOT/deploy/srs/accounts.sh"

mkdir -p "$REPORT_DIR"
echo "══ eMeal MASTER AUDIT — $TS ══  reports → deploy/audit-reports/$TS/"
echo "   modules: ${SELECTED[*]}"

# ── Inline modules (db / system have no standalone script) ───────────────────
mod_db() {
  echo "── DATABASE DEEP PARAMETERS (read-only pg_stat queries) ──"
  docker exec emeal_postgres bash -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -x -c "
    SELECT
      pg_size_pretty(pg_database_size(current_database()))              AS db_size,
      round(100*sum(blks_hit)::numeric/nullif(sum(blks_hit)+sum(blks_read),0),2) AS cache_hit_pct,
      (SELECT setting FROM pg_settings WHERE name='"'"'max_connections'"'"')      AS max_connections,
      (SELECT count(*) FROM pg_stat_activity)                           AS active_connections,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='"'"'public'"'"')          AS index_count,
      (SELECT count(*) FROM pg_stat_user_tables WHERE n_dead_tup > 10000)          AS tables_needing_vacuum,
      (SELECT coalesce(sum(seq_scan),0) FROM pg_stat_user_tables
         WHERE seq_scan > idx_scan AND n_live_tup > 10000)              AS big_table_seq_scans
    FROM pg_stat_database WHERE datname=current_database();"'
  echo "── Top 5 tables by size ──"
  docker exec emeal_postgres bash -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size,
           n_live_tup, n_dead_tup, seq_scan, idx_scan
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5;"'
}

mod_system() {
  echo "── SYSTEM HEALTH (read-only) ──"
  uptime
  free -m | awk 'NR<=2'
  df -hP / | awk 'NR<=2'
  echo "── PM2 ──"
  command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | jq -r \
    '.[] | "  \(.name)[\(.pm_id)] mem=\((.monit.memory/1048576)|floor)MB cpu=\(.monit.cpu)% restarts=\(.pm2_env.restart_time) unstable=\(.pm2_env.unstable_restarts)"'
  echo "── Docker ──"
  docker ps --format '  {{.Names}}  {{.Status}}' 2>/dev/null
  echo "── App error log (last 24h lines) ──"
  ERRS=$(find "$HOME/.pm2/logs" -name '*error*.log' -mmin -1440 -exec cat {} + 2>/dev/null | grep -c . || echo 0)
  echo "  pm2 error-log lines (24h): $ERRS"
  echo "── TLS ──"
  D=$(echo | timeout 10 openssl s_client -servername api.emilestone.com -connect api.emilestone.com:443 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -n "$D" ] && echo "  cert expires: $D"
  echo "── Services ──"
  for s in fail2ban ufw; do echo "  $s: $(systemctl is-active "$s" 2>/dev/null || echo unknown)"; done
}

# ── Runner ───────────────────────────────────────────────────────────────────
declare -A RESULT
run_module() { # $1 = name
  local m="$1" log="$REPORT_DIR/$1.log" rc=0
  echo; echo "═════ MODULE: $m  [${MOD_IMPACT[$m]}] ═════"
  case "$m" in
    diagnose)    bash deploy/diagnose-slowdown.sh              2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    benchmark)   bash deploy/benchmark-full.sh                 2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    certificate) bash deploy/generate-certificate.sh "${CERT_ARGS[@]+"${CERT_ARGS[@]}"}" 2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    srs)         ( WRITE_TESTS=$WRITES bash deploy/srs/run.sh )  2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    security)    ( cd deploy/srs && bash security.sh )          2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    fixtures)    bash deploy/ensure-test-fixtures.sh            2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    db)          mod_db                                         2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    unidoctor)   bash deploy/uni-index-doctor.sh                2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    system)      mod_system                                     2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    recovery)    bash deploy/verify-auto-recovery.sh            2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    e2e)         bash deploy/validate-e2e.sh                    2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    mealcheck)   bash deploy/validate-meal-attendance-billing.sh 2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    production)  bash deploy/validate-production.sh             2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    load)        docker run --rm -i --network host -v "$ROOT/deploy:/s" grafana/k6 run /s/loadtest.js \
                                                                2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
    checklist)   REPORT_DIR="$REPORT_DIR" bash deploy/checklist-190.sh \
                                                                2>&1 | tee "$log"; rc=${PIPESTATUS[0]};;
  esac
  RESULT["$m"]=$rc
  echo "───── $m finished (exit=$rc, log=deploy/audit-reports/$TS/$m.log) ─────"
}

# certificate module: pass attestations through if provided via env
CERT_ARGS=()
[ -n "${APK_MB:-}" ] && CERT_ARGS+=(--apk-mb "$APK_MB")
[ -n "${DEVICE_SMOKE:-}" ] && CERT_ARGS+=(--device-smoke "$DEVICE_SMOKE")

# Login-throttle cooldown: modules that authenticate freshly (each logs in for
# its own tokens) must start from a COLD per-IP login window (10/min), or a
# preceding flooder leaves them 429'd → empty token → false failures. Sleep the
# throttle window before each such module (skip before the very first module,
# and skip entirely with COOLDOWN=0).
COOLDOWN="${COOLDOWN:-65}"
declare -A NEEDS_COLD=( [security]=1 [srs]=1 [e2e]=1 [mealcheck]=1 [production]=1 [fixtures]=1 )

# ── RUN-ONCE DEDUP CONTRACT (user ruling 2026-07-18) ────────────────────────
# Every module ALWAYS runs its full own section set. Run-once dedup applies
# ONLY where the IDENTICAL script file would otherwise execute twice in one
# session:
#   • srs skips re-sourcing security.sh when the `security` module already ran
#     (its FR-SECX tags reconcile via the SHARED requirements log below);
#   • certificate grades from the benchmark module's log instead of running
#     benchmark-full.sh a second time.
# e2e / production never thin their sections under this orchestrator; the
# manual opt-ins E2E_DEDUP=1 / PROD_DEDUP=1 exist but run.sh does NOT set them.
export AUDIT_DEDUP=1
export AUDIT_MODULES="${SELECTED[*]}"
# Write-mode flag: opt-in sections that would defer to the srs WRITE lifecycle
# may only defer when srs actually runs its write flows.
export AUDIT_WRITES="$WRITES"
# Shared traceability sink: security + srs append to ONE requirements.tsv, so
# the srs certificate reconciles security's FR-SECX tags without re-running.
export RESULTS_DIR="/tmp/emeal-srs-$TS"
# Session log dir for evidence reuse (e.g. certificate grades from the
# benchmark module's log instead of re-running the whole endpoint battery).
export AUDIT_REPORT_DIR="$REPORT_DIR"

FIRST=1
for m in "${SELECTED[@]}"; do
  [ -n "$m" ] || continue
  if [ "$FIRST" -ne 1 ] && [ -n "${NEEDS_COLD[$m]:-}" ] && [ "$COOLDOWN" -gt 0 ]; then
    echo "   ⏳ login-throttle cooldown ${COOLDOWN}s before '$m' (COOLDOWN=0 to disable)…"
    sleep "$COOLDOWN"
  fi
  FIRST=0
  run_module "$m"
done

# ── Master certificate ───────────────────────────────────────────────────────
MASTER="$REPORT_DIR/MASTER_AUDIT.md"
FAILED=0
{
  echo "# 🏆 eMeal MASTER AUDIT CERTIFICATE"
  echo
  echo "- **Run (UTC):** $(date -u '+%Y-%m-%d %H:%M')  ·  **Host:** $(hostname)"
  echo "- **Release:** $(git rev-parse --short HEAD 2>/dev/null)  ·  **Accounts:** $ADMIN_EMAIL / $STUDENT_EMAIL"
  echo "- **Baseline contract:** all modules decoupled from production (read-only unless flagged)."
  echo
  echo "| Module | Impact | Verdict | Key metrics (from log) |"
  echo "|---|---|---|---|"
  for m in "${SELECTED[@]}"; do
    [ -n "$m" ] || continue
    rc=${RESULT[$m]:-1}; v="✅ PASS"; [ "$rc" -eq 1 ] && v="🟡 ADVISORY"; [ "$rc" -ge 2 ] && { v="❌ FAIL"; FAILED=1; }
    key=$(case "$m" in
      benchmark)   grep -E '^  rows=' "$REPORT_DIR/$m.log" | tail -1;;
      certificate) grep -E 'Verdict|CERTIFIED' "$REPORT_DIR/$m.log" | tail -1;;
      srs)         grep -iE 'manifest|requirements|coverage|PASS.*FAIL' "$REPORT_DIR/$m.log" | tail -1;;
      load)        grep -E 'http_req_duration|checks' "$REPORT_DIR/$m.log" | head -2 | tr '\n' ' ';;
      db)          grep -E 'cache_hit_pct' "$REPORT_DIR/$m.log" | tail -1;;
      system)      grep -E 'unstable=' "$REPORT_DIR/$m.log" | head -1;;
      checklist)   grep -E '^  PASS=' "$REPORT_DIR/$m.log" | tail -1;;
      diagnose)    grep -E 'VERDICT|avg steal' "$REPORT_DIR/$m.log" | tail -1;;
      mealcheck)   grep -E '^  PASS=' "$REPORT_DIR/$m.log" | tail -1;;
      *)           tail -1 "$REPORT_DIR/$m.log";;
    esac)
    printf '| %s | %s | %s | %s |\n' "$m" "${MOD_IMPACT[$m]}" "$v" "$(echo "$key" | head -c 160 | sed 's/|/\\|/g')"
  done
  echo
  echo "## Capacity & Limits (what this platform can handle, and where the ceilings are)"
  echo
  if [ -f "$REPORT_DIR/load.log" ]; then
    echo "**Measured this run (k6 ramp 100→500→1000 VUs, GET-only):**"
    echo '```'
    grep -E 'http_req_duration|http_reqs|errors|vus_max|checks' "$REPORT_DIR/load.log" | head -8
    echo '```'
  else
    echo "_Load module not run this time (add --load). Standing certified capability:_"
    echo "_1000 concurrent users served at p95 < 300 ms, ~944 req/s sustained (Handbook PART 15)._"
  fi
  echo
  echo "**Architectural ceilings (by design — know them before scaling):**"
  echo "- Nginx per-IP rate limit ≈1000 req/min (protects prod; single-IP floods throttle by design)"
  echo "- /auth/login throttled 10/min/IP (credential-stuffing defence)"
  echo "- 4 PM2 workers on 4 vCPU; DB pool 4×10=40 of max_connections=100"
  echo "- Single-node VPS: vertical headroom only; the parked levers for the next"
  echo "  tier are an India edge/CDN region and (much later) a second node."
  echo
  if [ "$FAILED" -eq 0 ]; then
    echo "## VERDICT: 🏆 ALL SELECTED AUDITS PASSED"
  else
    echo "## VERDICT: ❌ AT LEAST ONE MODULE FAILED — see its log before certifying"
  fi
  echo
  echo "Per-module full logs: \`deploy/audit-reports/$TS/\`. Parameter totals:"
  echo "benchmark ~32 endpoints·6 stats · certificate 13 graded params · SRS manifest"
  echo "664 requirements · security/e2e/production suites per their logs · db 12 ·"
  echo "system 10 — a full --all --writes --load run covers 700+ real parameters."
} > "$MASTER"

echo
echo "══ MASTER CERTIFICATE → deploy/audit-reports/$TS/MASTER_AUDIT.md ══"
grep -E '^\| |VERDICT' "$MASTER"
[ "$FAILED" -eq 0 ] && exit 0 || exit 2
