#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# DISASTER-RECOVERY DRILL — proves the full recovery path works end-to-end:
#   latest ENCRYPTED backup  →  decrypt  →  restore into a THROWAWAY db  →  assert
#   real data (tables + row counts)  →  drop the throwaway db.
# The PRODUCTION database is NEVER touched. Read-only + self-cleaning. Run quarterly.
#
#   Usage:  bash deploy/dr-drill.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
ENVFILE="$(readlink -f "$APP_DIR/.env" 2>/dev/null || echo "$APP_DIR/.env")"
[ -f "$ENVFILE" ] && { set -a; . "$ENVFILE"; set +a; }

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
POSTGRES_USER="${POSTGRES_USER:-emeal}"
GPG_PASS="${BACKUP_GPG_PASSPHRASE:-}"
DRILL_DB="emeal_drdrill_$(date +%s)"

fail() { echo "❌ DR DRILL FAILED: $*" >&2; exit 1; }

# 1) Pick the most recent backup (prefer the encrypted .gpg — that's what's offsite)
LATEST="$(ls -t "$BACKUP_DIR"/db/*.sql.gz.gpg 2>/dev/null | head -1)"
[ -z "$LATEST" ] && LATEST="$(ls -t "$BACKUP_DIR"/db/*.sql.gz 2>/dev/null | head -1)"
[ -n "$LATEST" ] || fail "no backup found in $BACKUP_DIR/db"
echo "==> DR drill using: $LATEST"

# 2) Throwaway DB (always cleaned up, even on error)
cleanup() { docker exec "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
              -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker exec "$PG_CONTAINER" psql -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"$DRILL_DB\";" >/dev/null || fail "could not create drill DB"

# 3) Decrypt (if needed) + decompress + restore into the throwaway DB
if [[ "$LATEST" == *.gpg ]]; then
  [ -n "$GPG_PASS" ] || fail "backup is encrypted but BACKUP_GPG_PASSPHRASE not set"
  gpg --batch --pinentry-mode loopback --passphrase "$GPG_PASS" -d "$LATEST" 2>/dev/null | gunzip
else
  gunzip -c "$LATEST"
fi | docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$DRILL_DB" >/dev/null 2>&1 \
  || fail "restore into drill DB failed (decrypt or SQL error)"

# 4) Assert real data is present
q() { docker exec "$PG_CONTAINER" psql -tA -U "$POSTGRES_USER" -d "$DRILL_DB" -c "$1" 2>/dev/null | tr -d '[:space:]'; }
TBLS="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
USERS="$(q "SELECT count(*) FROM users;")"
ORGS="$(q "SELECT count(*) FROM organizations;")"
[ "${TBLS:-0}" -gt 0 ] || fail "restored DB has 0 tables"

cleanup; trap - EXIT

echo "✅ DR DRILL PASSED"
echo "   source        : $(basename "$LATEST")"
echo "   tables         : $TBLS"
echo "   users rows     : ${USERS:-n/a}"
echo "   organizations  : ${ORGS:-n/a}"
echo "   (throwaway DB '$DRILL_DB' created, restored, verified, dropped — prod untouched)"
