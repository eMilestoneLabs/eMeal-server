# eMeal — SERVER GUIDEBOOK
> Single reference for: (1) what is installed on the production VPS, (2) how to
> redeploy after a code push, and (3) how to stand up a brand-new server from zero.
> Reflects the state after the 2026-06-26 infrastructure upgrade (Tracks A/B/C).
> Stack: Ubuntu 24.04 LTS · Docker (Postgres/Redis/MinIO) · Node 20 + PM2 · Nginx + Certbot.
> SECURITY: this file contains NO secret values — only where they live.

---

# PART 1 — CURRENT SERVER STATE (deep inventory)

## 1.1 Host
| Item | Value | Verify |
|---|---|---|
| OS | Ubuntu 24.04.x LTS | `lsb_release -d` |
| CPU / RAM / Disk | 4 vCPU · ~8 GB · ~72 GB | `nproc; free -h; df -h /` |
| Swap | 2 GB `/swapfile`, `vm.swappiness=10` | `swapon --show` |
| Timezone | UTC | `timedatectl \| grep Time` |
| File limits | `nofile` 65535 (login) / 1048576 (PM2 workers) | `ulimit -n` |
| Auto updates | unattended-upgrades enabled | `systemctl is-enabled unattended-upgrades` |

## 1.2 Security
| Item | State | Verify |
|---|---|---|
| Firewall (UFW) | active — allow 22/80/443, deny incoming | `sudo ufw status verbose` |
| Fail2Ban | active, sshd jail (5 tries / 1h ban) | `sudo fail2ban-client status sshd` |
| SSH | ⚠️ **still allows root + password login** — harden when a key is set | `sudo sshd -T \| grep -E 'permitroot\|passwordauth'` |
| TLS | Let's Encrypt (api + cdn), auto-renew | `sudo certbot certificates` |
| Secrets | `~/eMeal-server/.env` → `.env.production` (chmod 600), rotated 2026-06-26 | `ls -l ~/eMeal-server/.env*` |

## 1.3 Runtime
| Component | Version / Config | Notes |
|---|---|---|
| Node.js | v20.x (nvm) | `node -v` |
| PM2 | 7.x, **cluster, 4 workers** `emeal-server` | `pm2 status` |
| pm2-logrotate | 100 MB cap / retain 30 / daily | module |
| PM2 autostart | systemd `pm2-emeal.service` | resurrects on reboot |
| App | `emeal-server@1.0.0` (NestJS), port 127.0.0.1:3000 | health: `/api/v1/health` |

## 1.4 Data services — `docker-compose.prod.yml` (all bound to 127.0.0.1)
| Container | Image | Port | Volume | Limit |
|---|---|---|---|---|
| emeal_postgres | postgres:16-alpine | 5432 | postgres_data | mem 2 GB |
| emeal_redis | redis:7.2-alpine (requirepass + AOF) | 6379 | redis_data | mem 768 MB |
| emeal_minio | **minio/minio:RELEASE.2025-09-07T16-13-09Z** (pinned) | 9000/9001 | minio_data | mem 1.5 GB |

All have log caps (20 MB × 5) and `restart: unless-stopped`.

## 1.5 Monitoring — `deploy/monitoring/docker-compose.monitoring.yml` (all 127.0.0.1, UFW-blocked)
| Container | Port | Purpose |
|---|---|---|
| emeal_prometheus | 9090 | metrics store (host network) |
| emeal_node_exporter | 9100 | host CPU/RAM/disk (host network) |
| emeal_cadvisor | 8080 | container metrics (bridge) |
| emeal_postgres_exporter | 9187 | DB metrics (host network) |
| emeal_redis_exporter | 9121 | Redis metrics (host network) |
| emeal_grafana | 3002 | dashboards (host network) |
| emeal_uptime_kuma | 3001 | uptime + alerts (bridge) |

> Monitoring `.env` is a **symlink** → `../../.env.production` (one source of truth).
> Access from your PC: `ssh -L 3002:127.0.0.1:3002 -L 3001:127.0.0.1:3001 emeal@<ip>`.

## 1.6 Nginx (ingress)
- `api.emilestone.com` → `127.0.0.1:3000` (REST + Socket.IO/WSS), rate-limit 30 r/s, HSTS, `server_tokens off`.
- `cdn.emilestone.com` → `127.0.0.1:9000` (MinIO), `Cache-Control: public, max-age=31536000, immutable`.
- Config: `/etc/nginx/sites-available/emilestone` (from repo `nginx/emilestone.conf`).

## 1.7 Backups / cron
- `crontab -l` → `0 2 * * * BACKUP_REMOTE=gdrive:eMeal-Backups ~/eMeal-server/deploy/backup.sh ...`
- Produces: `~/backups/db/*.sql.gz` (restore-verified), `~/backups/config/*.tar.gz` (.env + configs), `~/backups/minio/` mirror, weekly/monthly tiers, offsite copy to Google Drive (`rclone`).

---

# PART 2 — REDEPLOY AFTER A CODE PUSH

## 2.1 The short answer: **yes, `deploy.sh` is enough** for a normal backend code push.
```bash
cd ~/eMeal-server && ./deploy/deploy.sh
```
It runs, in order, with **automatic rollback** on any failure:
1. pre-deploy backup (db + restore-verify + config + offsite)
2. git clean check + `git pull --ff-only`
3. `docker compose -f docker-compose.prod.yml up -d` (data services)
4. `npm ci`  →  `npx prisma generate`  →  `npm run build`
5. `npx prisma migrate deploy`
6. `pm2 reload` (zero-downtime)  →  retrying health check
7. on failure at any step → resets to previous commit, rebuilds, reloads, exits non-zero
8. writes a line to `deploy/deploy.log`

Expected tail:
```
==> Deploy complete: <newsha> (healthy)
```

## 2.2 When `deploy.sh` is NOT enough — changing `.env` secrets/config
`deploy.sh` uses `pm2 reload`. PM2 **caches the process env** (from `pm2 save`), and
the app's dotenv does **not** override already-set env vars — so a changed `.env`
value won't take effect via reload. If you edit `.env` (rotate a secret, change a URL):
```bash
cd ~/eMeal-server
pm2 delete emeal-server
pm2 start ecosystem.config.js --env production
pm2 save
```
(Data-service password changes also need the container recreated + the role/requirepass
updated — see PART 4 "Rotate secrets".)

## 2.3 Manual decision guide (Option B)
| What changed | Run |
|---|---|
| `.ts` source only | `npm run build && pm2 reload ecosystem.config.js` |
| `package.json`/lock | add `npm ci` |
| `prisma/schema.prisma` / new migration | add `npx prisma generate && npx prisma migrate deploy` |
| `docker-compose.prod.yml` | `docker compose -f docker-compose.prod.yml up -d` |
| `nginx/emilestone.conf` | copy to sites-available, `sudo nginx -t && sudo systemctl reload nginx` |
| `.env` value | `pm2 delete emeal-server && pm2 start ecosystem.config.js --env production` |

---

# PART 3 — STAND UP A BRAND-NEW SERVER (migration from zero)

> Goal: replicate this production stack on a fresh Ubuntu 22.04/24.04 VPS.
> Most of it is automated by `deploy/setup-vps.sh`. Steps below show the full path
> with expected output. Run as a sudo-capable non-root user (create one first).

### STEP 0 — Provision + first login
Create the VPS (e.g. Contabo), get its IP, then:
```bash
ssh root@<NEW_IP>
adduser emeal && usermod -aG sudo emeal      # create the deploy user
# log out, then back in as emeal:
ssh emeal@<NEW_IP>
```

### STEP 1 — Clone the repo
```bash
sudo apt-get update && sudo apt-get install -y git
git clone git@github.com:eMilestoneLabs/eMeal-server.git ~/eMeal-server
cd ~/eMeal-server && git checkout eMeal-server
```
Expect: repo present, branch `eMeal-server`.

### STEP 2 — Run the automated provisioner
```bash
bash deploy/setup-vps.sh
```
This installs/configures: base packages, **UFW** (22/80/443), **Docker + Compose**,
**Node 20 (nvm) + PM2 + logrotate + systemd autostart**, **rclone**, then OS hardening
via `harden-server.sh` (**swap, UTC, ulimits, fail2ban, SSH-guard, unattended-upgrades**),
**journald + Docker log caps**, app dirs, and the **backup cron**.
Expected final block:
```
==> 12/12 Done — remaining MANUAL steps
  1) DNS ...  2) Secrets ...  3) SSL ...  4) MinIO bucket ...  5) rclone ...  6) Deploy ...
```
> If Docker group was just added: `newgrp docker` (or log out/in) before continuing.

### STEP 3 — DNS (registrar)
Add A records → new IP: `api` and `cdn` (TTL 300).
Verify: `nslookup api.emilestone.com` → new IP.

### STEP 4 — Secrets (`.env`)
```bash
cd ~/eMeal-server
cp .env.production.example .env.production
ln -sf .env.production .env
chmod 600 .env.production
# generate strong values and fill every CHANGE_ME:
for v in PG REDIS JWT_A JWT_R MINIO BULL; do echo "$v=$(openssl rand -hex 32)"; done
nano .env.production
```
Must set: `POSTGRES_PASSWORD` (+ same value inside `DATABASE_URL`), `REDIS_PASSWORD`,
`JWT_ACCESS_SECRET` ≠ `JWT_REFRESH_SECRET`, `MINIO_SECRET_KEY`, `BULL_BOARD_PASSWORD/SECRET`,
`STORAGE_CDN_URL=https://cdn.emilestone.com`.
Verify: `grep -c CHANGE_ME .env` → `0`.

### STEP 5 — Start data services
```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```
Expect: `emeal_postgres`, `emeal_redis`, `emeal_minio` all `Up ... (healthy)`.

### STEP 6 — Create the MinIO bucket (public-read for images)
```bash
source ~/eMeal-server/.env
docker run --rm --network host -e MINIO_ACCESS_KEY -e MINIO_SECRET_KEY -e MINIO_BUCKET \
  --entrypoint /bin/sh minio/mc -c '
    mc alias set l http://localhost:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" &&
    mc mb -p l/"$MINIO_BUCKET" &&
    mc anonymous set download l/"$MINIO_BUCKET"'
```
Expect: `Bucket created` + `Access permission ... set to download`.

### STEP 7 — Build + migrate + start the app
```bash
cd ~/eMeal-server
npm ci
npx prisma generate
npm run build
npx prisma migrate deploy            # provisions the schema
pm2 start ecosystem.config.js --env production
pm2 save
curl -s http://localhost:3000/api/v1/health; echo
```
Expect: `pm2 status` → 4 workers `online`; health → `{"status":"ok","database":"connected","redis":"connected",...}`.

### STEP 8 — Nginx + SSL
```bash
sudo cp nginx/emilestone.conf /etc/nginx/sites-available/emilestone
sudo ln -sf /etc/nginx/sites-available/emilestone /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
# issue certs FIRST time (the repo conf references cert paths, so on a brand-new box
# temporarily comment the ssl_certificate lines OR use certbot's standalone, then re-copy):
sudo certbot --nginx -d api.emilestone.com -d cdn.emilestone.com
sudo nginx -t && sudo systemctl reload nginx
```
Expect: `nginx -t` → `syntax is ok / test is successful`; `curl -I https://api.emilestone.com/api/v1/health` → 200.

### STEP 9 — Offsite backups (rclone → Google Drive)
```bash
rclone config            # create a remote named "gdrive" (scope: drive.file)
BACKUP_REMOTE=gdrive:eMeal-Backups ./deploy/backup.sh
```
Expect: `Backup OK: ...sql.gz  restore-verified=1`; `rclone ls gdrive:eMeal-Backups` shows files.

### STEP 10 — Monitoring (optional)
```bash
cd ~/eMeal-server/deploy/monitoring
ln -sf ../../.env.production .env
# ensure GRAFANA_USER/GRAFANA_PASSWORD exist in .env.production (add if missing)
docker compose -f docker-compose.monitoring.yml up -d
curl -s http://127.0.0.1:9090/-/healthy; echo                 # "Prometheus Server is Healthy"
curl -s 'http://127.0.0.1:9090/api/v1/targets' | grep -o '"health":"[a-z]*"' | sort | uniq -c
```
Expect: `5 "health":"up"`.

### STEP 11 — SSH hardening (after a key is installed)
```bash
# from your PC:  ssh-copy-id emeal@<NEW_IP>
bash deploy/harden-server.sh          # now detects the key and locks SSH to key-only/no-root
# keep this session open; test a NEW ssh login before closing
```
Expect: `sudo sshd -T | grep -E 'permitroot|passwordauth'` → both `no`.

### STEP 12 — Go-live verification
```bash
curl -s https://api.emilestone.com/api/v1/health; echo        # status:ok
docker compose -f docker-compose.prod.yml ps                  # all healthy
pm2 status                                                    # 4 online
sudo fail2ban-client status sshd                              # active
sudo certbot certificates                                     # valid
crontab -l                                                    # backup cron present
```

---

# PART 4 — COMMON OPERATIONS

**Redeploy:** `cd ~/eMeal-server && ./deploy/deploy.sh`
**Manual backup:** `BACKUP_REMOTE=gdrive:eMeal-Backups ./deploy/backup.sh`
**Restore a DB dump:** `gunzip -c ~/backups/db/emeal_<ts>.sql.gz | docker exec -i emeal_postgres psql -U emeal -d emeal_db`
**Logs:** `pm2 logs emeal-server` · `docker compose -f docker-compose.prod.yml logs --tail=50 <svc>`
**After reboot:** everything auto-starts (containers `unless-stopped`, PM2 systemd). Verify with PART 3 STEP 12.

### Rotate secrets (DB/Redis/JWT/MinIO/Bull)
```bash
cd ~/eMeal-server
cp -L .env.production .env.production.bak.$(date +%s)
NEW_PG=$(openssl rand -hex 32); NEW_REDIS=$(openssl rand -hex 32)
docker exec -i emeal_postgres psql -U emeal -d postgres -c "ALTER USER emeal WITH PASSWORD '$NEW_PG';"
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEW_PG|" .env.production
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"postgresql://emeal:$NEW_PG@localhost:5432/emeal_db\"|" .env.production
sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$NEW_REDIS|" .env.production
# (repeat sed for JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, MINIO_SECRET_KEY, BULL_BOARD_*)
docker compose -f docker-compose.prod.yml config >/dev/null && echo ENV_OK
docker compose -f docker-compose.prod.yml up -d            # recreates redis/minio with new creds
pm2 delete emeal-server && pm2 start ecosystem.config.js --env production && pm2 save   # NOT reload
cd deploy/monitoring && docker compose -f docker-compose.monitoring.yml up -d           # exporters
curl -s https://api.emilestone.com/api/v1/health; echo
```

---

# PART 5 — TROUBLESHOOTING (lessons learned)

| Symptom | Cause | Fix |
|---|---|---|
| `502 Bad Gateway` after a secret rotation | app used OLD secret — PM2 cached env (`pm2 save`); dotenv won't override `process.env` | `pm2 delete emeal-server && pm2 start ecosystem.config.js --env production` (never `reload --update-env` for env changes) |
| Redis log: `WRONGPASS ... auth` | app `REDIS_PASSWORD` ≠ container `requirepass` | recreate redis (`docker compose up -d`) + clean PM2 start (above) |
| pg/redis exporter `connection timed out` / `couldn't connect` | exporters on docker bridge can't reach DB/Redis bound to host `127.0.0.1` | exporters use `network_mode: host` (already set in monitoring compose) |
| `.env` parse error `unexpected character` | a malformed appended line | `sed -i --follow-symlinks '/^BADKEY=/,$d' .env` then re-add cleanly; validate `docker compose config` |
| `docker compose up -d` shows `Running` not `Recreated` after env change | the resolved config didn't actually change → secret not written | confirm `.env` actually edited (`grep` for old value) |
| Deploy failed mid-way | `deploy.sh` auto-rolled back to previous commit | check `deploy/deploy.log`; fix; re-run |

---

# PART 6 — NEVER DO
- Never expose 5432 / 6379 / 9000 publicly (keep `127.0.0.1` binding).
- Never commit `.env*`, `rclone.conf`, or keystores.
- Never `docker compose down -v` (the `-v` deletes data volumes).
- Never hand-edit the prod DB schema — only `npx prisma migrate deploy`.
- Never bump Redis past 7.2 without a license review.
- For `.env` changes use `pm2 delete && pm2 start`, not `pm2 reload`.
