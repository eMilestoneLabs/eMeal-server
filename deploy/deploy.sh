#!/usr/bin/env bash
# Release/redeploy on the VPS. Zero-downtime PM2 reload. Run from repo root.
# Usage:  cd /opt/emeal-server && ./deploy/deploy.sh
set -euo pipefail

echo "==> Backup database first"
mkdir -p /opt/backups
if docker ps --format '{{.Names}}' | grep -q emeal_postgres; then
  docker exec emeal_postgres pg_dump -U "${POSTGRES_USER:-emeal}" "${POSTGRES_DB:-emeal_db}" \
    > "/opt/backups/emeal_$(date +%Y%m%d_%H%M%S).sql" || echo "WARN: pg_dump skipped"
fi

echo "==> Pull latest"
git pull origin main

echo "==> Data services (postgres + redis + minio)"
docker compose -f docker-compose.prod.yml up -d

echo "==> Install + build"
npm ci
npm run build

echo "==> Apply migrations (deploy, not dev)"
npx prisma migrate deploy

echo "==> Reload app (PM2 cluster)"
pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js --env production
pm2 save

echo "==> Health check"
sleep 5
curl -fsS http://localhost:3000/api/v1/health && echo "  OK" || { echo "HEALTH CHECK FAILED"; exit 1; }
echo "==> Deploy complete"
