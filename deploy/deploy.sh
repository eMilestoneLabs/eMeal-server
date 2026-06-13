#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Release / redeploy on the VPS. Zero-downtime PM2 reload.
# Run from anywhere:   bash ~/eMeal-server/deploy/deploy.sh
# Steps: backup -> pull -> data services -> deps -> build -> migrate -> reload -> health.
#
# Env overrides:
#   BRANCH         default: eMeal-server
#   BACKUP_REMOTE  default: gdrive:eMeal-Backups   (offsite during the pre-deploy backup)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"
BRANCH="${BRANCH:-eMeal-server}"
export BACKUP_REMOTE="${BACKUP_REMOTE:-gdrive:eMeal-Backups}"

echo "==> 1/7 Pre-deploy backup (db + minio + offsite)"
bash "$SCRIPT_DIR/backup.sh" || echo "WARN: backup step failed — continuing deploy"

echo "==> 2/7 Pull latest ($BRANCH)"
git pull origin "$BRANCH"

echo "==> 3/7 Data services (postgres + redis + minio)"
docker compose -f docker-compose.prod.yml up -d

echo "==> 4/7 Install dependencies (npm ci)"
npm ci

echo "==> 5/7 Build (nest build)"
npm run build

echo "==> 6/7 Apply migrations (prisma migrate deploy)"
npx prisma migrate deploy

echo "==> 7/7 Reload app (PM2 cluster, zero-downtime)"
pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js --env production
pm2 save

echo "==> Health check"
sleep 5
curl -fsS http://localhost:3000/api/v1/health && echo "  OK" || { echo "HEALTH CHECK FAILED"; exit 1; }
echo "==> Deploy complete"
