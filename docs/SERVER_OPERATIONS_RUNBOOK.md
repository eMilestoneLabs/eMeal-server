# SERVER OPERATIONS RUNBOOK — eMeal-server (production)
> The single reference for what is installed on the VPS, how it's wired, where secrets
> live, how to redeploy after a git push, and how to operate day-to-day.
> Server: Contabo VPS 10 · IP 5.189.153.205 · Ubuntu 24.04 LTS · user `emeal`.
> Domain emilestone.com (Hostinger DNS). Last updated: 2026-06-13.
> SECURITY: this file intentionally contains NO secret values — only their LOCATION.

---

## 0. QUICK FACTS
| Item | Value |
|------|-------|
| SSH | `ssh emeal@5.189.153.205` (key-only; root login disabled) |
| Repo dir | `/home/emeal/eMeal-server` |
| Git remote / branch | `git@github.com:eMilestoneLabs/eMeal-server.git` / `eMeal-server` |
| App URL | https://api.emilestone.com/api/v1  (health: `/health`) |
| Image CDN | https://cdn.emilestone.com (MinIO) |
| App port (internal) | 127.0.0.1:3000 (behind Nginx) |
| Process manager | PM2 (cluster, 4 instances) → `emeal-server` |
| Env file | `/home/emeal/eMeal-server/.env` → symlink → `.env.production` (chmod 600) |
| Backups | `/home/emeal/backups/` (+ offsite: Google Drive `gdrive:eMeal-Backups`) |

---

## 1. INSTALLED SOFTWARE & VERSIONS (as deployed 2026-06-13)
| Component | Version | How installed | Notes |
|-----------|---------|---------------|-------|
| Ubuntu Server | 24.04.4 LTS | Contabo image | |
| Node.js | v20.20.2 | nvm (`~/.nvm`) | `nvm use 20` default |
| npm | 10.8.2 | with Node | |
| PM2 | 7.0.1 | `npm i -g pm2` | systemd unit `pm2-emeal.service` |
| pm2-logrotate | 3.0.0 | `pm2 install pm2-logrotate` | 100M / retain 7 / compress / daily |
| Docker | 29.5.2 | get.docker.com | `emeal` in `docker` group |
| Docker Compose | v2 (reported v5.1.4) | Docker plugin | `docker compose ...` |
| Nginx | 1.24.0 (Ubuntu) | apt | reverse proxy + SSL |
| Certbot | 2.9.0 | apt | Let's Encrypt, auto-renew timer |
| rclone | 1.74.3 | rclone.org/install.sh | offsite backup to Google Drive |
| Prisma CLI/Client | 5.22.0 | npm (project) | ORM + migrations |
| App | emeal-server@1.0.0 | git + `npm ci` + `npm run build` | NestJS 10 |
| Postgres (container) | postgres:16-alpine | docker-compose.prod.yml | data: vol `emeal-server_postgres_data` |
| Redis (container) | redis:7.2-alpine | docker-compose.prod.yml | BSD-3 (keep ≤7.2 — see LICENSES.md) |
| MinIO (container) | minio/minio:latest | docker-compose.prod.yml | data: vol `emeal-server_minio_data` |
| Firewall | UFW | apt | allow 22/80/443 only |
| fail2ban | apt | brute-force protection on SSH |
| Swap | 2 GB | `/swapfile` | build headroom |

Git config on server: `core.fileMode false` (so `chmod +x` on scripts doesn't block pulls).

---

## 2. HOW IT'S ALL CONNECTED (request path)
```
Phone / app  ──HTTPS/WSS──>  Nginx (:443, SSL)
                               ├── api.emilestone.com  ─proxy─>  PM2 cluster  127.0.0.1:3000  (NestJS)
                               │                                    ├── Postgres  127.0.0.1:5432  (Prisma)
                               │                                    ├── Redis     127.0.0.1:6379  (cache/queues/tokens/ws-adapter)
                               │                                    └── MinIO     127.0.0.1:9000  (writes meal images)
                               └── cdn.emilestone.com  ─proxy─>  MinIO  127.0.0.1:9000  (serves meal images)
Backups: cron 02:00 → deploy/backup.sh → pg_dump + MinIO mirror → ~/backups → rclone → Google Drive
```
- Postgres/Redis/MinIO are **only** reachable on 127.0.0.1 (never public). Nginx is the only ingress.
- Containers run via `docker-compose.prod.yml` (restart: unless-stopped). App runs via PM2 (NOT in a container).
- Nginx site: `/etc/nginx/sites-available/emilestone` (symlinked into `sites-enabled`).
- SSL certs: `/etc/letsencrypt/live/api.emilestone.com/` and `.../cdn.emilestone.com/` (certbot auto-renews).

---

## 3. SECRETS — WHERE THEY LIVE (values NOT stored here, by design)
| Secret | Location on server | How to view |
|--------|--------------------|-------------|
| DB password, JWT access/refresh, Redis password, MinIO keys, Bull Board secret | `~/eMeal-server/.env.production` (symlinked as `.env`, chmod 600) | `cat ~/eMeal-server/.env` |
| rclone Google Drive OAuth token | `~/.config/rclone/rclone.conf` (chmod 600) | `rclone config show gdrive` |
| SSH login | key-based (`~/.ssh/authorized_keys`) | n/a |
| Backup SSH key (unused/legacy) | `~/.ssh/backup_key` | n/a |
| SSL private keys | `/etc/letsencrypt/live/*/privkey.pem` (root) | managed by certbot |

RULES: never commit `.env*` or `rclone.conf` to git (they are gitignored). Never paste these
values into chats, docs, screenshots, or tickets. To rotate JWT/DB secrets: edit `.env`,
then `pm2 reload ecosystem.config.js --update-env` (DB password change also needs the DB
user altered — ask before doing that).

---

## 4. REDEPLOY AFTER A `git push` (what to run on the server)
**Option A — one command (recommended): `./deploy/deploy.sh`**
It does: pg_dump backup → `git pull` → `docker compose up -d` → `npm ci` → `npm run build`
→ `npx prisma migrate deploy` → `pm2 reload` → health check.
```bash
cd ~/eMeal-server && ./deploy/deploy.sh
```

**Option B — manual (when you want control / understand each step):**
```bash
cd ~/eMeal-server
git pull origin eMeal-server
npm ci                              # ONLY if package-lock.json changed (new deps)
npx prisma generate                 # ONLY if prisma/schema.prisma changed
npx prisma migrate deploy           # ONLY if new files in prisma/migrations/
npm run build                       # always (recompile dist/)
pm2 reload ecosystem.config.js --update-env   # zero-downtime restart
sleep 4 && curl -s https://api.emilestone.com/api/v1/health; echo
```
Decision guide for what changed:
- Only `.ts` source changed → `npm run build` + `pm2 reload`.
- `package.json`/lockfile changed → add `npm ci`.
- `prisma/schema.prisma` or new migration → add `npx prisma generate && npx prisma migrate deploy`.
- `docker-compose.prod.yml` changed → `docker compose -f docker-compose.prod.yml up -d`.
- `nginx/emilestone.conf` changed → copy to `/etc/nginx/sites-available/`, `sudo nginx -t && sudo systemctl reload nginx`.
- `.env` changed → `pm2 reload ecosystem.config.js --update-env`.

ROLLBACK: `git checkout <previous-commit> && npm ci && npm run build && pm2 reload ecosystem.config.js --update-env`
(DB: restore a dump from `~/backups/db/` only if a migration was destructive — see §6.)

---

## 5. DAY-TO-DAY OPERATIONS
App (PM2):
```bash
pm2 status                       # health of the 4 workers + logrotate module
pm2 logs emeal-server            # live logs (Ctrl+C to exit)
pm2 logs emeal-server --lines 50 --nostream
pm2 reload emeal-server          # zero-downtime restart
pm2 restart emeal-server         # hard restart
pm2 monit                        # live CPU/mem dashboard
```
Data services (Docker):
```bash
docker compose -f ~/eMeal-server/docker-compose.prod.yml ps
docker compose -f ~/eMeal-server/docker-compose.prod.yml logs --tail=50 postgres
docker exec -it emeal_postgres psql -U emeal -d emeal_db   # DB shell
docker exec -it emeal_redis redis-cli                       # (then AUTH <redis pw>)
```
Health / SSL:
```bash
curl -s https://api.emilestone.com/api/v1/health; echo
sudo certbot certificates          # cert expiry
sudo certbot renew --dry-run       # test renewal
sudo systemctl status certbot.timer
```
Nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/error.log
```

---

## 6. BACKUPS & RESTORE
- Script: `~/eMeal-server/deploy/backup.sh`. Output: `~/backups/db/*.sql.gz`, `~/backups/minio/`, logs in `~/backups/{backup,offsite,cron}.log`.
- Offsite: Google Drive remote `gdrive:eMeal-Backups` (rclone, scope drive.file, free).
- Manual backup now:
```bash
cd ~/eMeal-server && BACKUP_REMOTE=gdrive:eMeal-Backups ./deploy/backup.sh
```
- List backups: `ls -lh ~/backups/db/`  ·  offsite: `rclone ls gdrive:eMeal-Backups`
- RESTORE a dump into the DB:
```bash
gunzip -c ~/backups/db/emeal_YYYYMMDD_HHMMSS.sql.gz | docker exec -i emeal_postgres psql -U emeal -d emeal_db
```
- Retention: local db dumps pruned after 30 days; Drive keeps full history (rclone copy, no delete).

---

## 7. CRON JOBS (user `emeal`: `crontab -l`)
```
0 2 * * * BACKUP_REMOTE=gdrive:eMeal-Backups /home/emeal/eMeal-server/deploy/backup.sh >> /home/emeal/backups/cron.log 2>&1
```
- Runs daily 02:00: local pg_dump + MinIO mirror + offsite push to Google Drive.
- Edit cron: `crontab -e`. Verify: `crontab -l`. Logs: `tail ~/backups/cron.log`.
- Certbot renewal runs via its own systemd timer (not cron): `systemctl status certbot.timer`.

---

## 8. AUTO-RECOVERY (after reboot — verified working)
- Docker containers: `restart: unless-stopped` → auto-start.
- PM2 app: `pm2-emeal.service` (systemd) → resurrects the saved process list.
- After `sudo reboot`, verify: `docker ps`, `pm2 status`, `curl .../health`. No manual start needed.
- If PM2 list ever changes, re-save: `pm2 save`.

---

## 9. NEVER DO
- Never expose 5432/6379/9000 publicly (keep `127.0.0.1` binding in docker-compose.prod.yml).
- Never commit `.env*`, `rclone.conf`, or `*.jks`/keystores.
- Never hand-edit the production DB schema — only `npx prisma migrate deploy`.
- Never `docker compose down -v` (the `-v` deletes data volumes!). Use `down` without `-v`.
- Never bump Redis past 7.2 without a license review (see docs/LICENSES.md).
- Never run `npm audit fix --force` on the frozen backend without testing.
