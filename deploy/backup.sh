#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# eMeal nightly backup — PostgreSQL + MinIO objects + config/secrets, with
# integrity + RESTORE VERIFICATION, tiered retention (daily/weekly/monthly),
# and OPTIONAL offsite push via rclone (Google Drive — free).
#
# A backup is NOT considered valid until BOTH succeed:
#   (a) gzip integrity check  (gunzip -t)
#   (b) restore verification  (dump is restored into a THROWAWAY database and
#       its table count is asserted > 0, then the throwaway DB is dropped)
# The production database is NEVER touched by the verification.
#
# Runs as the deploy user (in the `docker` group). No sudo required.
#   Manual:  ./deploy/backup.sh
#   Cron:    0 2 * * * BACKUP_REMOTE=gdrive:eMeal-Backups /home/emeal/eMeal-server/deploy/backup.sh >> /home/emeal/backups/cron.log 2>&1
#
# Env overrides (optional):
#   BACKUP_DIR        default: $HOME/backups
#   RETENTION_DAYS    default: 30   (local daily db dumps)
#   RETENTION_WEEKS   default: 12   (weekly copies, taken on Sundays)
#   RETENTION_MONTHS  default: 12   (monthly copies, taken on day 01)
#   PG_CONTAINER      default: emeal_postgres
#   VERIFY_RESTORE    default: 1    (0 disables restore verification)
#   BACKUP_REMOTE     default: ""   (rclone remote:path, e.g. gdrive:eMeal-Backups)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
RETENTION_WEEKS="${RETENTION_WEEKS:-12}"
RETENTION_MONTHS="${RETENTION_MONTHS:-12}"
PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
VERIFY_RESTORE="${VERIFY_RESTORE:-1}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
TS="$(date +%Y%m%d_%H%M%S)"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/minio" "$BACKUP_DIR/config" \
         "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"

logline() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }
fail()    { logline "ERROR $*"; echo "BACKUP FAILED: $*" >&2; exit 1; }

# Load env (resolves .env -> .env.production symlink) for POSTGRES_*/MINIO_*
ENVFILE="$(readlink -f "$APP_DIR/.env" 2>/dev/null || echo "$APP_DIR/.env")"
if [ -f "$ENVFILE" ]; then set -a; . "$ENVFILE"; set +a; fi
POSTGRES_USER="${POSTGRES_USER:-emeal}"
POSTGRES_DB="${POSTGRES_DB:-emeal_db}"
MINIO_BUCKET="${MINIO_BUCKET:-emeal-images}"

logline "backup start"
DUMP="$BACKUP_DIR/db/emeal_${TS}.sql.gz"

# ── 1) PostgreSQL dump ───────────────────────────────────────────────────────
docker exec "$PG_CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "$DUMP" || fail "pg_dump failed"

# ── 2) Integrity check (the gzip must be complete and uncorrupted) ───────────
gunzip -t "$DUMP" || fail "integrity check (gunzip -t) failed for $DUMP"
logline "integrity OK $DUMP"

# ── 3) RESTORE VERIFICATION (throwaway DB — prod DB untouched) ───────────────
if [ "$VERIFY_RESTORE" = "1" ]; then
  VDB="emeal_verify_${TS}"
  cleanup_vdb() { docker exec "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS \"$VDB\";" >/dev/null 2>&1 || true; }
  trap cleanup_vdb EXIT
  docker exec "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
    -c "CREATE DATABASE \"$VDB\";" >/dev/null || fail "could not create verify DB"
  gunzip -c "$DUMP" | docker exec -i "$PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$VDB" >/dev/null 2>>"$LOG" \
    || fail "restore into verify DB failed (dump not restorable)"
  TBLS="$(docker exec "$PG_CONTAINER" psql -tAU "$POSTGRES_USER" -d "$VDB" \
    -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -d '[:space:]')"
  cleanup_vdb; trap - EXIT
  [ "${TBLS:-0}" -gt 0 ] || fail "restore verified DB has 0 tables — dump suspect"
  logline "restore verification OK ($TBLS tables)"
fi

# ── 4) MinIO object mirror (bucket -> local; removes deleted objects) ────────
docker run --rm --network host --entrypoint /bin/sh \
  -v "$BACKUP_DIR/minio:/backup" minio/mc -c "\
  mc alias set local http://localhost:9000 '${MINIO_ACCESS_KEY:-}' '${MINIO_SECRET_KEY:-}' >/dev/null && \
  mc mirror --overwrite --remove local/${MINIO_BUCKET} /backup" \
  && logline "minio mirror OK" \
  || logline "WARN minio mirror skipped/failed"

# ── 5) Config + secrets backup (needed to rebuild a dead server) ─────────────
# .env holds the ONLY copy of DB/JWT/MinIO secrets — without it, DB dumps are
# unusable on a fresh box. Stored locally + offsite (offsite is private; rclone
# scope drive.file). Permissions kept tight.
CONF_TAR="$BACKUP_DIR/config/config_${TS}.tar.gz"
tar -czf "$CONF_TAR" -C "$APP_DIR" \
  --ignore-failed-read \
  .env .env.production ecosystem.config.js docker-compose.prod.yml nginx 2>/dev/null || true
[ -f "$APP_DIR/.env" ] && { crontab -l 2>/dev/null > "$BACKUP_DIR/config/crontab_${TS}.txt" || true; }
chmod 600 "$CONF_TAR" 2>/dev/null || true
logline "config backup $CONF_TAR"

# ── 6) Tiered copies (weekly on Sunday, monthly on the 1st) ──────────────────
[ "$(date +%u)" = "7" ] && cp "$DUMP" "$BACKUP_DIR/weekly/"  && logline "weekly copy taken"
[ "$(date +%d)" = "01" ] && cp "$DUMP" "$BACKUP_DIR/monthly/" && logline "monthly copy taken"

# ── 7) Retention pruning (local) ─────────────────────────────────────────────
find "$BACKUP_DIR/db"      -name 'emeal_*.sql.gz'  -mtime +"$RETENTION_DAYS"          -delete
find "$BACKUP_DIR/config"  -name 'config_*.tar.gz' -mtime +"$RETENTION_DAYS"          -delete
find "$BACKUP_DIR/config"  -name 'crontab_*.txt'   -mtime +"$RETENTION_DAYS"          -delete
find "$BACKUP_DIR/weekly"  -name 'emeal_*.sql.gz'  -mtime +"$((RETENTION_WEEKS*7))"   -delete
find "$BACKUP_DIR/monthly" -name 'emeal_*.sql.gz'  -mtime +"$((RETENTION_MONTHS*31))" -delete

# ── 8) Offsite push (rclone copy = keeps full remote history, never deletes) ─
if [ -n "$BACKUP_REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  if rclone copy "$BACKUP_DIR" "$BACKUP_REMOTE" --transfers 4 --checkers 8 \
       --exclude 'cron.log' --exclude 'backup.log' --exclude 'offsite.log' \
       --log-file "$BACKUP_DIR/offsite.log" --log-level INFO; then
    logline "offsite copy OK -> $BACKUP_REMOTE"
  else
    logline "WARN offsite copy failed -> $BACKUP_REMOTE"
  fi
fi

SIZE="$(du -h "$DUMP" | cut -f1)"
logline "backup OK  db=emeal_${TS}.sql.gz ($SIZE)  verified=${VERIFY_RESTORE}"
echo "Backup OK: $DUMP ($SIZE)  restore-verified=${VERIFY_RESTORE}${BACKUP_REMOTE:+  +offsite:$BACKUP_REMOTE}"
