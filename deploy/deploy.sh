#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# eMeal release / redeploy on the VPS. Zero-downtime PM2 reload, with
# pre-deploy backup, git validation, automatic ROLLBACK on failure, a deploy
# journal, and a retrying health check.
#   Run:   cd ~/eMeal-server && ./deploy/deploy.sh
#
# Flow: backup -> record rollback point -> pull -> data services -> deps ->
#       prisma generate -> build -> migrate -> reload -> health(retry).
# If build/migrate/health FAILS, the code is reset to the previous commit,
# rebuilt, and PM2 reloaded so the last-known-good release keeps serving.
# (DB rollback from a destructive migration is manual — restore a dump; see §6
#  of SERVER_OPERATIONS_RUNBOOK.md. backup.sh runs first precisely for this.)
#
# Env overrides:
#   BRANCH         default: eMeal-server
#   BACKUP_REMOTE  default: gdrive:eMeal-Backups
#   SKIP_BACKUP    default: 0   (1 = skip pre-deploy backup — NOT recommended)
#   HEALTH_URL     default: http://localhost:3000/api/v1/health
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"
BRANCH="${BRANCH:-eMeal-server}"
export BACKUP_REMOTE="${BACKUP_REMOTE:-gdrive:eMeal-Backups}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/v1/health}"
JOURNAL="$APP_DIR/deploy/deploy.log"

journal() { echo "[$(date -Iseconds)] $*" >> "$JOURNAL"; echo "$*"; }

PREV_COMMIT="$(git rev-parse HEAD)"
journal "DEPLOY START branch=$BRANCH from=$PREV_COMMIT"

rollback() {
  journal "!! FAILURE at step: $1 — rolling back to $PREV_COMMIT"
  git reset --hard "$PREV_COMMIT" >/dev/null 2>&1 || true
  npm ci || true
  npx prisma generate || true
  npm run build || true
  pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js --env production || true
  journal "ROLLBACK COMPLETE — serving $PREV_COMMIT (DB NOT rolled back; restore a dump if a migration was destructive)"
  exit 1
}

echo "==> 1/8 Pre-deploy backup (db + verify + minio + config + offsite)"
if [ "$SKIP_BACKUP" != "1" ]; then
  bash "$SCRIPT_DIR/backup.sh" || { journal "pre-deploy backup FAILED"; echo "Refusing to deploy without a backup. Override with SKIP_BACKUP=1."; exit 1; }
else
  journal "WARN pre-deploy backup skipped (SKIP_BACKUP=1)"
fi

echo "==> 2/8 Git validation + pull ($BRANCH)"
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit/stash local changes before deploying:"; git status --short; exit 1
fi
git fetch origin "$BRANCH" || rollback "git fetch"
git pull --ff-only origin "$BRANCH" || rollback "git pull (non-fast-forward)"
NEW_COMMIT="$(git rev-parse HEAD)"
if [ "$NEW_COMMIT" = "$PREV_COMMIT" ]; then journal "no new commits — redeploying same code ($NEW_COMMIT)"; fi

echo "==> 3/8 Data services (postgres + redis + minio)"
docker compose -f docker-compose.prod.yml up -d || rollback "docker compose up"

echo "==> 4/8 Install dependencies (npm ci)"
npm ci || rollback "npm ci"

echo "==> 5/8 Generate Prisma Client"
npx prisma generate || rollback "prisma generate"

echo "==> 6/8 Build (nest build)"
npm run build || rollback "nest build"

echo "==> 7/8 Apply migrations (prisma migrate deploy)"
npx prisma migrate deploy || rollback "prisma migrate deploy"

echo "==> 7b/8 Data backfills (idempotent — 0 rows after first run)"
# ACC-005 legacy grandfather: accounts created before the EmailVerifiedGuard
# shipped get emailVerifiedAt stamped so participation writes keep working.
# Non-fatal: a hiccup here must never roll back a good release.
if ! bash "$SCRIPT_DIR/backfill-email-verified.sh"; then
  # Loud on the console, not only in the journal: a skipped backfill means
  # every legacy account keeps failing participation taps with 403
  # EMAIL_VERIFICATION_REQUIRED (this exact failure shipped silently once).
  echo "!!==============================================================!!"
  echo "!!  WARN: email-verified backfill FAILED (release continues).   !!"
  echo "!!  Legacy users CANNOT mark attendance until you run:          !!"
  echo "!!      bash deploy/backfill-email-verified.sh                  !!"
  echo "!!==============================================================!!"
  journal "WARN email-verified backfill failed (non-fatal — run manually: bash deploy/backfill-email-verified.sh)"
fi

echo "==> 8/8 Reload app (PM2 cluster, zero-downtime)"
# --env production is REQUIRED: without it, pm2 reload falls back to the default
# `env` block (NODE_ENV=development), which leaks _devOtp in responses + weakens
# security. Keep production env on reload.
pm2 reload ecosystem.config.js --update-env --env production || pm2 start ecosystem.config.js --env production || rollback "pm2 reload"
pm2 save || true

echo "==> Health check (retry up to 10x)"
ok=0
for i in $(seq 1 10); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = "1" ] || rollback "health check"

# ==> Warm the WHOLE cluster before declaring done. A freshly reloaded worker
# JIT-compiles routes/guards/serializers on its first requests; with 4 workers
# behind round-robin, the first ~dozen real requests each pay that cost — which
# is exactly what a benchmark run straight after deploy measures (false "SLOW"
# rows, e.g. exports max=1762ms on 2026-07-12). 16 unauthenticated hits spread
# over hot route families touch every worker several times; login is NOT
# called (10/min throttle stays untouched for the user/benchmark).
echo "==> Warm-up (16 hits across the PM2 cluster)"
API_BASE="${HEALTH_URL%/health}"
for i in $(seq 1 4); do
  for p in /health /dashboard/admin /groups /notices/unread-count; do
    curl -s -o /dev/null --max-time 5 "$API_BASE$p" || true
  done
done

journal "DEPLOY OK  $PREV_COMMIT -> $NEW_COMMIT"
echo "==> Deploy complete: $NEW_COMMIT (healthy)"
