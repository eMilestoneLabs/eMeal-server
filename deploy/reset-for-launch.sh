#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# reset-for-launch.sh — wipe ALL test data for a clean Play‑Store launch.
#
# Erases every row in every business table (accounts, organizations, groups,
# meals, attendance, schedules, events, notices, audit logs, tokens, …), removes
# all test images from MinIO, and flushes Redis (cache/sessions/queues/tokens).
# The SCHEMA and migration history are PRESERVED (no Prisma changes) — so the
# app boots clean and the first real signup creates the first org from scratch.
#
# ⚠️  DESTRUCTIVE & IRREVERSIBLE (except from the backup it takes first).
#
# SAFEGUARDS:
#   • Takes a FULL verified backup first (refuses to wipe if the backup fails).
#   • DRY‑RUN by default — shows what WOULD be deleted, changes nothing.
#   • To actually wipe you must BOTH pass --confirm AND type the exact phrase.
#
#   Preview (safe):   bash deploy/reset-for-launch.sh
#   Execute:          bash deploy/reset-for-launch.sh --confirm
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
BUCKET="${MINIO_BUCKET:-emeal-images}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/v1/health}"
CONFIRM_PHRASE="ERASE ALL DATA FOR LAUNCH"

CONFIRM=0; [ "${1:-}" = "--confirm" ] && CONFIRM=1
psql(){ docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" "$@"; }

echo "==================================================================="
echo "  eMeal — RESET FOR LAUNCH    (DB=$PG_DB  bucket=$BUCKET)"
echo "==================================================================="

# ── Current data snapshot ────────────────────────────────────────────────────
echo "Current data (what will be erased):"
psql -c "SELECT 'organizations' t, count(*) FROM organizations
 UNION ALL SELECT 'users', count(*) FROM users
 UNION ALL SELECT 'groups', count(*) FROM groups
 UNION ALL SELECT 'meals', count(*) FROM meals
 UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records
 UNION ALL SELECT 'events', count(*) FROM events
 UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs ORDER BY 1;" 2>/dev/null || { echo "Cannot read DB — aborting."; exit 1; }
OBJ=$(docker run --rm --network host --entrypoint /bin/sh -e MK="${MINIO_ACCESS_KEY:-}" -e SK="${MINIO_SECRET_KEY:-}" -e BK="$BUCKET" minio/mc -c 'mc alias set l http://localhost:9000 "$MK" "$SK" >/dev/null 2>&1 && mc ls --recursive l/$BK 2>/dev/null | wc -l')
echo "MinIO objects to remove: ${OBJ:-?}"

# ── Tables to truncate (everything except migration history) ─────────────────
TABLES=$(psql -tA -c "SELECT string_agg(quote_ident(tablename), ', ') FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations';" 2>/dev/null)
[ -n "$TABLES" ] || { echo "Could not list tables — aborting."; exit 1; }

if [ "$CONFIRM" != "1" ]; then
  echo
  echo "DRY‑RUN — nothing changed. Would TRUNCATE: $TABLES"
  echo "Would remove all MinIO objects and FLUSH Redis."
  echo "Re‑run with --confirm to execute (you will also be asked to type a phrase)."
  exit 0
fi

# ── Final human confirmation ─────────────────────────────────────────────────
echo
echo "⚠️  This PERMANENTLY erases ALL data above. Recoverable only from the backup taken next."
read -p "Type exactly:  $CONFIRM_PHRASE  : " typed
[ "$typed" = "$CONFIRM_PHRASE" ] || { echo "Phrase mismatch — aborted. Nothing changed."; exit 1; }

# ── 1) Mandatory full backup FIRST ───────────────────────────────────────────
echo "==> 1/5 Full verified backup before wipe…"
bash "$SCRIPT_DIR/backup.sh" || { echo "Backup FAILED — refusing to wipe."; exit 1; }

# ── 2) Truncate all business tables (schema preserved) ───────────────────────
echo "==> 2/5 Truncating all data tables (schema + migrations preserved)…"
psql -c "TRUNCATE TABLE $TABLES RESTART IDENTITY CASCADE;" || { echo "TRUNCATE failed."; exit 1; }

# ── 3) Wipe MinIO objects (keep bucket + public‑read policy) ──────────────────
echo "==> 3/5 Removing all MinIO objects (bucket + policy kept)…"
docker run --rm --network host --entrypoint /bin/sh -e MK="${MINIO_ACCESS_KEY:-}" -e SK="${MINIO_SECRET_KEY:-}" -e BK="$BUCKET" minio/mc -c '
  mc alias set l http://localhost:9000 "$MK" "$SK" >/dev/null 2>&1 &&
  mc rm --recursive --force l/$BK/ >/dev/null 2>&1; echo "  objects now: $(mc ls --recursive l/$BK 2>/dev/null | wc -l)"' || echo "  WARN: MinIO wipe issue (check manually)"

# ── 4) Flush Redis (cache/sessions/queues/token families) ────────────────────
echo "==> 4/5 Flushing Redis…"
docker exec -i emeal_redis redis-cli -a "${REDIS_PASSWORD:-}" --no-auth-warning FLUSHALL >/dev/null 2>&1 && echo "  Redis flushed" || echo "  WARN: Redis flush issue"

# ── 5) Clean app restart + verify ────────────────────────────────────────────
echo "==> 5/5 Clean PM2 restart + health check…"
pm2 delete emeal-server >/dev/null 2>&1 || true
pm2 start ecosystem.config.js --env production >/dev/null 2>&1 || true
pm2 save >/dev/null 2>&1 || true
ok=0; for i in $(seq 1 10); do curl -fsS "$HEALTH_URL" >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done

echo
echo "Verification — all counts should be 0:"
psql -c "SELECT 'organizations' t, count(*) FROM organizations UNION ALL SELECT 'users', count(*) FROM users UNION ALL SELECT 'groups', count(*) FROM groups UNION ALL SELECT 'meals', count(*) FROM meals UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records ORDER BY 1;"
[ "$ok" = "1" ] && echo "✅ App healthy. CLEAN SLATE ready for Play‑Store launch (first signup creates the first org)." \
                || echo "⚠️ App health check did not pass — run: pm2 logs emeal-server"
echo "Backup of the erased test data is in ~/backups/db (restore instructions: docs/SERVER_HANDBOOK.md PART 6)."
