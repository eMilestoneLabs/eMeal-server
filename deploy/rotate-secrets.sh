#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rotate-secrets.sh — regenerate ALL internal secrets, write them into
# .env.production (the single source of truth), apply to every live service,
# restart cleanly, and verify. Auto-rollback if the health check fails.
#
# Rotates (no external dependency):
#   POSTGRES_PASSWORD (+ DATABASE_URL) · REDIS_PASSWORD · JWT_ACCESS_SECRET
#   JWT_REFRESH_SECRET · MINIO_SECRET_KEY · BULL_BOARD_PASSWORD · BULL_BOARD_SECRET
#
# Does NOT rotate (managed outside the server — rotate those manually):
#   • TELEGRAM_BOT_TOKEN  → @BotFather /revoke
#   • ALERT_SMTP_PASS     → Hostinger mailbox password
#   • BACKUP_GPG_PASSPHRASE → rotating it would make OLD encrypted backups
#                             undecryptable, so it is deliberately left alone.
#   • GRAFANA_PASSWORD    → change inside Grafana UI (stored in its own DB)
#
# Effects: all users must log in again (JWT changed). Data is preserved.
#   Run:   bash deploy/rotate-secrets.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail   # NOT -e: we want explicit checks + health-based rollback

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"
ENVFILE="$(readlink -f "$APP_DIR/.env" 2>/dev/null || echo "$APP_DIR/.env.production")"
PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"
HEALTH_URL="${HEALTH_URL:-https://api.emilestone.com/api/v1/health}"
PG_USER="$(grep -E '^POSTGRES_USER=' "$ENVFILE" | cut -d= -f2-)"; : "${PG_USER:=emeal}"
PG_DB="$(grep -E '^POSTGRES_DB=' "$ENVFILE" | cut -d= -f2-)";   : "${PG_DB:=emeal_db}"
OLD_PG="$(grep -E '^POSTGRES_PASSWORD=' "$ENVFILE" | cut -d= -f2-)"
BAK="$ENVFILE.bak.$(date +%s)"

die() { echo "ERROR: $*" >&2; exit 1; }
set_kv() { sed -i "s|^$1=.*|$1=$2|" "$ENVFILE"; }   # line-anchored; hex values = sed-safe

echo "==> 1/9 Backup current env  ->  $BAK"
cp -L "$ENVFILE" "$BAK" || die "could not back up env"

echo "==> 2/9 Generate new secrets"
NEW_PG=$(openssl rand -hex 32);   NEW_REDIS=$(openssl rand -hex 32)
NEW_JWT_A=$(openssl rand -hex 64); NEW_JWT_R=$(openssl rand -hex 64)
NEW_MINIO=$(openssl rand -hex 32); NEW_BULLPW=$(openssl rand -hex 16)
NEW_BULLSEC=$(openssl rand -hex 24)

echo "==> 3/9 Rewrite .env.production (every place, incl. DATABASE_URL)"
set_kv POSTGRES_PASSWORD "$NEW_PG"
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"postgresql://$PG_USER:$NEW_PG@localhost:5432/$PG_DB\"|" "$ENVFILE"
set_kv REDIS_PASSWORD     "$NEW_REDIS"
set_kv JWT_ACCESS_SECRET  "$NEW_JWT_A"
set_kv JWT_REFRESH_SECRET "$NEW_JWT_R"
set_kv MINIO_SECRET_KEY   "$NEW_MINIO"
set_kv BULL_BOARD_PASSWORD "$NEW_BULLPW"
set_kv BULL_BOARD_SECRET   "$NEW_BULLSEC"

echo "==> 4/9 Validate env still parses (before touching any service)"
if ! docker compose -f docker-compose.prod.yml config >/dev/null 2>&1; then
  cp "$BAK" "$ENVFILE"; die "env failed to parse — restored backup, nothing changed"
fi
echo "   ENV_OK"

echo "==> 5/9 Change the live Postgres role password"
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c "ALTER USER \"$PG_USER\" WITH PASSWORD '$NEW_PG';" || die "ALTER USER failed"

echo "==> 6/9 Recreate data services (redis/minio/pg pick up new creds)"
docker compose -f docker-compose.prod.yml up -d

echo "==> 7/9 Clean PM2 restart (env-cache safe: delete + start, NOT reload)"
pm2 delete emeal-server >/dev/null 2>&1 || true
pm2 start ecosystem.config.js --env production
pm2 save

echo "==> 8/9 Refresh monitoring exporters (read pg/redis pw via symlinked env)"
if [ -f deploy/monitoring/docker-compose.monitoring.yml ]; then
  ( cd deploy/monitoring && docker compose -f docker-compose.monitoring.yml up -d ) || true
fi

echo "==> 9/9 Health verification (retry up to 12x)"
ok=0
for i in $(seq 1 12); do curl -fsS "$HEALTH_URL" >/dev/null 2>&1 && { ok=1; break; }; sleep 3; done

if [ "$ok" = "1" ]; then
  echo "✅ ROTATION OK — $(curl -s "$HEALTH_URL")"
  echo "   Old env saved at $BAK (delete once you've confirmed everything works)."
  echo "   Reminder: rotate externally-managed secrets too (Telegram token, SMTP pw, Grafana pw)."
else
  echo "❌ Health check FAILED — AUTO-ROLLBACK"
  cp "$BAK" "$ENVFILE"
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
    -c "ALTER USER \"$PG_USER\" WITH PASSWORD '$OLD_PG';" || true
  docker compose -f docker-compose.prod.yml up -d || true
  pm2 delete emeal-server >/dev/null 2>&1 || true
  pm2 start ecosystem.config.js --env production || true
  ( cd deploy/monitoring && docker compose -f docker-compose.monitoring.yml up -d ) 2>/dev/null || true
  echo "   Rolled back to previous secrets. Investigate before retrying."
  exit 1
fi
