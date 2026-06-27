#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# enable-pg-stat-statements.sh — turn on slow-query visibility (additive, infra-only).
#
# docker-compose.prod.yml now preloads the pg_stat_statements library. This script:
#   1. recreates the postgres container so the preload takes effect (brief restart),
#   2. creates the extension in the app DB (idempotent),
#   3. verifies it, and
#   4. prints the current top-20 slowest statements (mean time) as evidence.
# The production database is otherwise untouched. No app code / schema change.
#
#   Run:  bash deploy/enable-pg-stat-statements.sh
#   Later, anytime, just the report:  bash deploy/enable-pg-stat-statements.sh report
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"
ENVFILE="$(readlink -f "$APP_DIR/.env" 2>/dev/null || echo "$APP_DIR/.env")"
[ -f "$ENVFILE" ] && { set -a; . "$ENVFILE"; set +a; }
PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
PG_USER="${POSTGRES_USER:-emeal}"
PG_DB="${POSTGRES_DB:-emeal_db}"

psqlc() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" "$@"; }

report() {
  echo "==> Top 20 slowest statements (by mean exec time):"
  psqlc -c "
    SELECT round(mean_exec_time::numeric,2) AS avg_ms,
           calls,
           round(total_exec_time::numeric,2) AS total_ms,
           left(regexp_replace(query, '\s+', ' ', 'g'), 90) AS query
    FROM pg_stat_statements
    ORDER BY mean_exec_time DESC
    LIMIT 20;" 2>/dev/null \
  || echo "   (pg_stat_statements not available yet — run without 'report' first)"
}

if [ "${1:-}" = "report" ]; then report; exit 0; fi

echo "==> 1/3 Recreate postgres so the preloaded library is active (brief restart)"
docker compose -f docker-compose.prod.yml up -d postgres || { echo "compose up failed"; exit 1; }
# wait for health
for _ in $(seq 1 20); do
  docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 2
done

echo "==> 2/3 Create extension (idempotent)"
psqlc -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" || { echo "CREATE EXTENSION failed"; exit 1; }

echo "==> 3/3 Verify"
LOADED="$(psqlc -tAc "SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements';" 2>/dev/null | tr -d '[:space:]')"
if [ "$LOADED" = "1" ]; then
  echo "✅ pg_stat_statements ENABLED."
  echo "   Reset stats anytime:  docker exec $PG_CONTAINER psql -U $PG_USER -d $PG_DB -c 'SELECT pg_stat_statements_reset();'"
  echo
  echo "   (Let real traffic run for a while, then:  bash deploy/enable-pg-stat-statements.sh report)"
else
  echo "❌ Extension not active. Confirm postgres restarted with the new command:"
  echo "   docker exec $PG_CONTAINER psql -U $PG_USER -d $PG_DB -c 'SHOW shared_preload_libraries;'"
  exit 1
fi
