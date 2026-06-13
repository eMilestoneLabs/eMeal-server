#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Nightly backup — PostgreSQL dump + MinIO object mirror, with retention,
# plus OPTIONAL offsite push via rclone (e.g. Google Drive — free, no cost).
# Runs as the deploy user (must be in the `docker` group). No sudo required.
#
# Usage:   ./deploy/backup.sh
# Cron:    0 2 * * * BACKUP_REMOTE=gdrive:eMeal-Backups /home/emeal/eMeal-server/deploy/backup.sh >> /home/emeal/backups/cron.log 2>&1
#
# Env overrides (optional):
#   BACKUP_DIR      default: $HOME/backups
#   RETENTION_DAYS  default: 30   (LOCAL db dumps older than this are pruned)
#   PG_CONTAINER    default: emeal_postgres
#   BACKUP_REMOTE   default: ""   (set to an rclone remote:path to enable offsite
#                                  copy, e.g. gdrive:eMeal-Backups. No-op if unset
#                                  or if rclone is not installed. Uses `copy`, so
#                                  the remote keeps full history — never deleted.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
TS="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/minio"

# Load env (resolves the .env -> .env.production symlink) for POSTGRES_*/MINIO_*
ENVFILE="$(readlink -f "$APP_DIR/.env" 2>/dev/null || echo "$APP_DIR/.env")"
if [ -f "$ENVFILE" ]; then set -a; . "$ENVFILE"; set +a; fi

POSTGRES_USER="${POSTGRES_USER:-emeal}"
POSTGRES_DB="${POSTGRES_DB:-emeal_db}"
MINIO_BUCKET="${MINIO_BUCKET:-emeal-images}"

echo "[$(date -Iseconds)] backup start" >> "$BACKUP_DIR/backup.log"

# 1) PostgreSQL dump (local socket inside the container = no password prompt)
docker exec "$PG_CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "$BACKUP_DIR/db/emeal_${TS}.sql.gz"

# 2) MinIO object mirror (bucket -> local copy, removes deleted objects)
docker run --rm --network host --entrypoint /bin/sh \
  -v "$BACKUP_DIR/minio:/backup" minio/mc -c "\
  mc alias set local http://localhost:9000 '${MINIO_ACCESS_KEY:-}' '${MINIO_SECRET_KEY:-}' >/dev/null && \
  mc mirror --overwrite --remove local/${MINIO_BUCKET} /backup" || \
  echo "[$(date -Iseconds)] WARN minio mirror skipped/failed" >> "$BACKUP_DIR/backup.log"

# 3) Retention — prune LOCAL db dumps older than RETENTION_DAYS
find "$BACKUP_DIR/db" -name 'emeal_*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

# 4) OPTIONAL offsite push (rclone). copy = never deletes remote (keeps full history).
if [ -n "$BACKUP_REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  if rclone copy "$BACKUP_DIR" "$BACKUP_REMOTE" --transfers 4 --checkers 8 \
       --log-file "$BACKUP_DIR/offsite.log" --log-level INFO; then
    echo "[$(date -Iseconds)] offsite copy OK -> $BACKUP_REMOTE" >> "$BACKUP_DIR/backup.log"
  else
    echo "[$(date -Iseconds)] WARN offsite copy failed -> $BACKUP_REMOTE" >> "$BACKUP_DIR/backup.log"
  fi
fi

SIZE="$(du -h "$BACKUP_DIR/db/emeal_${TS}.sql.gz" | cut -f1)"
echo "[$(date -Iseconds)] backup OK  db=emeal_${TS}.sql.gz ($SIZE)" >> "$BACKUP_DIR/backup.log"
echo "Backup complete: $BACKUP_DIR/db/emeal_${TS}.sql.gz ($SIZE)${BACKUP_REMOTE:+  +offsite:$BACKUP_REMOTE}"
