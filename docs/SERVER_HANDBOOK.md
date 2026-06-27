# eMeal — SERVER HANDBOOK (complete end-to-end guide)
> The single source of truth for the production server: what is installed, how the
> backend connects to it, how to migrate to a brand-new VPS with one script, how to
> deploy, rotate secrets, change the GitHub repo, back up, monitor, and verify.
> Stack: Ubuntu 24.04 LTS · Docker (Postgres/Redis/MinIO) · Node 20 + PM2 · Nginx + Certbot.
> 100% open-source / commercially-free. Only paid items: VPS + domain + mail.
> SECURITY: contains NO secret values — only their location. Real `.env.production`
> lives ONLY on the server (gitignored). The `.env.production.example` template is in git.

---

# PART 0 — HOW IT ALL CONNECTS (app ↔ backend ↔ infra)

```
 Flutter app (phone)
     │  HTTPS / WSS (443)
     ▼
   Nginx  (TLS 1.2/1.3 via Certbot · rate-limit · HSTS · server_tokens off)
   ├── api.emilestone.com  ──proxy──►  PM2 cluster ×4  (NestJS)  127.0.0.1:3000
   │                                       │  reads /home/emeal/eMeal-server/.env
   │                                       ├─► Postgres  127.0.0.1:5432  (Prisma)
   │                                       ├─► Redis     127.0.0.1:6379  (cache/queues/tokens/ws/rate-limit)
   │                                       └─► MinIO     127.0.0.1:9000  (writes meal/avatar images)
   └── cdn.emilestone.com  ──proxy──►  MinIO 127.0.0.1:9000  (serves images, immutable cache)

 Monitoring (127.0.0.1, SSH-tunnel only): Prometheus 9090 · Grafana 3002 · Loki 3100
   · node/cAdvisor/pg/redis exporters · Uptime-Kuma 3001 · Promtail
 Backups: cron 02:00 → backup.sh → pg_dump(verify)+GPG-encrypt + MinIO mirror + config
          → ~/backups → rclone → Google Drive (offsite, encrypted)
 Alerts:  cron */5 → healthcheck-alert.sh → Telegram + Email on failure/cert-expiry
```

### Verified connection map (every link tested live — 2026-06-27)
```
                        ┌──────────────────────────┐
                        │       Flutter app        │   phone / web client
                        └─────────────┬────────────┘
                       HTTPS / WSS :443 │  ✓ login OK · 264-char JWT
                        ┌─────────────▼────────────┐
                        │    Nginx · TLS 1.2/1.3    │  sole ingress · HSTS
                        │    ✓ TLS1.0 refused       │  server_tokens off
                        └────┬─────────────────┬────┘
      api.emilestone.com →   │                 │   → cdn.emilestone.com
      ✓ endpoints 200        │                 │     ✓ image = 200 (Nginx bucket
      13–196ms (warm 13ms)   │                 │       injection fix)
                        ┌─────▼───────────┐     │
                        │ PM2 · NestJS ×4 │     │
                        │ 127.0.0.1:3000  │     │
                        │ ✓ status:ok     │     │
                        │   trust proxy   │     │
                        └──┬──────┬──────┬┘     │
              ┌────────────┘      │      └──────┼────────────┐
              ▼                   ▼             ▼            │ (cdn)
      ┌───────────────┐  ┌───────────────┐  ┌───────────────▼──┐
      │  PostgreSQL   │  │    Redis 7.2  │  │     MinIO (S3)    │
      │  :5432        │  │    :6379      │  │     :9000         │
      │ ✓ connected   │  │ ✓ connected   │  │ ✓ URLs only       │
      │ 83 idx·99.98% │  │ cache+queues  │  │ 0 orphans         │
      │ query 3.43ms  │  │ +token family │  │ img 72–97ms       │
      └───────────────┘  └───────────────┘  └───────────────────┘

  Monitoring → Prometheus + Grafana + Loki   ✓ 5/5 targets up · alerts (Telegram+email)
  Backups/DR → encrypted → Google Drive       ✓ DR drill PASSED (19 tables / 9 users / 4 orgs)
  After reboot → app + 4 workers + all containers auto-recover · ✓ image still 200 · 0 manual steps
```
> Legend: ✓ = verified by a command run on the live server (see docs/PRODUCTION_READINESS_AUDIT.md).
> All data ports (5432/6379/9000) are bound to 127.0.0.1; Nginx is the only public ingress (UFW: 22/80/443).

## How the backend codebase talks to the infrastructure
The NestJS backend is **configuration-driven**: it reads `~/eMeal-server/.env` (a symlink
to `.env.production`) at startup and connects to each service by env var. **Change a
connection by changing the env var — never hardcode.**

| Backend env var | Infra service it connects to | Used for |
|---|---|---|
| `DATABASE_URL` / `POSTGRES_*` | Postgres `127.0.0.1:5432` (via Prisma) | all persistent data |
| `REDIS_HOST/PORT/PASSWORD` | Redis `127.0.0.1:6379` | cache, BullMQ queues, refresh-token families, Socket.IO adapter, rate-limit, attendance dedup |
| `MINIO_*` + `STORAGE_CDN_URL` | MinIO `127.0.0.1:9000` | upload meal/avatar images → returns `https://cdn.emilestone.com/...` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | (in-app) | auth token signing |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | (in-app, per-IP) | API rate limiting (1000/min/IP) |
| `BULL_BOARD_*` | (in-app) | queue dashboard auth |
| `FIREBASE_*` | FCM (disabled until set) | push notifications |

- **PM2** runs the compiled `dist/main.js` as a 4-worker cluster on `127.0.0.1:3000`.
  PM2 caches a process's env at start — so a `.env` change needs a **clean restart**
  (`pm2 delete && pm2 start`), NOT `pm2 reload` (see PART 4).
- **Nginx** is the ONLY public ingress; Postgres/Redis/MinIO are bound to `127.0.0.1`
  and never exposed. UFW allows only 22/80/443.
- **Build/run pipeline:** `git pull` → `npm ci` → `prisma generate` → `npm run build`
  (creates `dist/`) → `prisma migrate deploy` → `pm2 reload`. Driven by `deploy/deploy.sh`.

---

# PART 1 — WHAT IS ON THE SERVER (inventory)

| Layer | Detail |
|---|---|
| OS | Ubuntu 24.04 LTS · 4 vCPU · ~8 GB RAM · 72 GB disk · 2 GB swap · UTC · ulimit 65535 |
| Runtime | Node 20 (nvm) · PM2 cluster ×4 + pm2-logrotate + systemd autostart |
| App | `emeal-server@1.0.0` (NestJS) · `127.0.0.1:3000` · health `/api/v1/health` |
| Data (Docker, 127.0.0.1) | `emeal_postgres` pg16 (2 GB cap) · `emeal_redis` 7.2 (768 MB, AOF) · `emeal_minio` pinned (1.5 GB) — all log-capped, `unless-stopped` |
| Monitoring (Docker, 127.0.0.1) | prometheus 9090 · grafana 3002 · loki 3100 · promtail · node/cAdvisor(8080)/pg(9187)/redis(9121) exporters · uptime-kuma 3001 — all mem-capped |
| Ingress | Nginx → api (REST/WSS) + cdn (MinIO, immutable cache) |
| Security | UFW(22/80/443) · Fail2Ban(sshd) · SSH key-only/no-root · TLS 1.2/1.3 · unattended-upgrades |
| Backups | cron 02:00 → encrypted dump + MinIO mirror + config → ~/backups → rclone → Google Drive |
| Alerts | cron */5 → Telegram + Email on health/cert problems |
| Secrets | `~/eMeal-server/.env` → `.env.production` (chmod 600); monitoring `.env` is a symlink to it |

**All software is open-source / commercially-free** (Apache/BSD/MIT/GPL/AGPL; AGPL items
— PM2/MinIO/Grafana/Loki/Promtail/k6 — are free because we run them unmodified for our own
use). See `docs/LICENSES.md`.

---

# PART 2 — BRAND-NEW SERVER MIGRATION (~95% one script)

> Goal: a blank Ubuntu VPS → production-ready, driven almost entirely by
> **`bash deploy/setup-vps.sh`**. No manual downloads — the script installs everything
> (Docker, Node, PM2, rclone, fail2ban, Nginx, Certbot, etc.) from official sources,
> AND auto-completes the data services, the MinIO bucket, and SSL once their
> prerequisites exist.
>
> **The pattern is RE-RUN, not one-shot.** The script is idempotent, so:
> 1. **Run it once** → installs + hardens everything; skips data/bucket/SSL (no `.env`/DNS yet).
> 2. **You do the irreducible ~5%** (the only things a script *shouldn't* own — they need
>    your credentials or one-time human consent): point **DNS**, fill the **`.env`** secret
>    values, do `rclone config` (Google OAuth consent).
> 3. **Re-run `setup-vps.sh`** → now it starts the data services, creates the MinIO bucket,
>    and issues SSL automatically (the SSL block only fires once DNS resolves to this host).
>
> Why not 100%? DNS lives at your registrar, the secret values exist only in your vault,
> and Google's OAuth consent needs a human click — putting those on the box would defeat
> the security they provide (the "secret-zero" problem). Everything mechanical IS automated;
> everything repeatable (deploy, rotate, backup, alert) is already one command.

### STEP 0 — provision + deploy user
```bash
ssh root@<NEW_IP>
adduser emeal && usermod -aG sudo emeal
# from your PC, install your key so SSH hardening can lock it down later:
ssh-copy-id emeal@<NEW_IP>          # (or paste your public key into ~emeal/.ssh/authorized_keys)
ssh emeal@<NEW_IP>
```

### STEP 1 — clone the repo
```bash
sudo apt-get update && sudo apt-get install -y git
git clone git@github.com:eMilestoneLabs/eMeal-server.git ~/eMeal-server
cd ~/eMeal-server && git checkout eMeal-server
```

### STEP 2 — run the automated provisioner
```bash
bash deploy/setup-vps.sh
```
Installs + configures: base pkgs · UFW · Docker+Compose · Node 20 (nvm) · PM2 +
logrotate + systemd autostart · rclone · **OS hardening** (swap, UTC, ulimits,
fail2ban, **SSH key-only/no-root if a key is present**, unattended-upgrades) ·
journald + Docker log caps · TLS-tightening of nginx.conf · app dirs · **backup cron**
+ **health-alert cron**. Idempotent — safe to re-run.
> If Docker group was just added: `newgrp docker` once.

### STEP 3 — DNS
At the registrar add A records → new IP: `api` and `cdn` (TTL 300).
Verify: `nslookup api.emilestone.com`.

### STEP 4 — secrets (`.env`)
```bash
cd ~/eMeal-server
cp .env.production.example .env.production && ln -sf .env.production .env && chmod 600 .env.production
nano .env.production       # fill every CHANGE_ME; STORAGE_CDN_URL=https://cdn.emilestone.com
grep -c CHANGE_ME .env.production    # must be 0
```
(Or run `bash deploy/rotate-secrets.sh` after the DB is up to auto-generate the internal ones — PART 4.)

### STEP 5 — data services
```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps       # all (healthy)
```

### STEP 6 — MinIO bucket (public-read for images) — **AUTOMATED**
`setup-vps.sh` (step 10/14) creates the bucket + sets public-read automatically once
`.env` is filled and MinIO is up. Just re-run `setup-vps.sh`. Manual fallback if needed:
```bash
source ~/eMeal-server/.env
docker run --rm --network host -e MINIO_ACCESS_KEY -e MINIO_SECRET_KEY -e MINIO_BUCKET \
  --entrypoint /bin/sh minio/mc -c '
    mc alias set l http://localhost:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" &&
    mc mb -p l/"$MINIO_BUCKET" && mc anonymous set download l/"$MINIO_BUCKET"'
```

### STEP 7 — build + migrate + start the app
```bash
npm ci && npx prisma generate && npm run build
npx prisma migrate deploy
pm2 start ecosystem.config.js --env production && pm2 save
pm2 startup systemd -u emeal --hp /home/emeal     # run the printed sudo line once
curl -s http://localhost:3000/api/v1/health; echo  # {status:ok,...}
```

### STEP 8 — Nginx + SSL — **AUTOMATED**
`setup-vps.sh` installs the Nginx vhost (step 11/14) and issues SSL non-interactively
(step 12/14) **as soon as `api.emilestone.com` resolves to this host** — so once DNS is
set, just re-run `setup-vps.sh`. Override domains/email with `API_DOMAIN`, `CDN_DOMAIN`,
`CERTBOT_EMAIL`. Manual fallback (e.g. DNS via a different provider):
```bash
sudo cp nginx/emilestone.conf /etc/nginx/sites-available/emilestone
sudo ln -sf /etc/nginx/sites-available/emilestone /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo certbot --nginx -d api.emilestone.com -d cdn.emilestone.com   # first-time cert
sudo nginx -t && sudo systemctl reload nginx
```

### STEP 9 — offsite backups (rclone)
```bash
rclone config            # create remote named "gdrive" (or a Backblaze B2 / R2 remote)
BACKUP_REMOTE=gdrive:eMeal-Backups bash deploy/backup.sh    # first run
```

### STEP 10 — monitoring (optional)
```bash
cd ~/eMeal-server/deploy/monitoring
ln -sf ../../.env.production .env
docker compose -f docker-compose.monitoring.yml up -d
```

### STEP 11 — final verification — see PART 9.

---

# PART 3 — DEPLOYMENTS (after a code push)

**One command, with auto-rollback + health check + journal:**
```bash
cd ~/eMeal-server && ./deploy/deploy.sh
```
Flow: pre-deploy backup → git clean check → `git pull --ff-only` → compose up →
`npm ci` → `prisma generate` → `npm run build` → `prisma migrate deploy` →
`pm2 reload` → retrying health check. On ANY failure it resets to the previous
commit, rebuilds, reloads, and exits non-zero. Logs to `deploy/deploy.log`.

**If a deploy also changes `.env` secrets** → after deploy run:
`pm2 delete emeal-server && pm2 start ecosystem.config.js --env production` (PM2 caches env).

**Manual decision guide** (when not using deploy.sh):
| Changed | Run |
|---|---|
| `.ts` only | `npm run build && pm2 reload ecosystem.config.js` |
| `package.json`/lock | add `npm ci` |
| `prisma/schema.prisma` / new migration | add `npx prisma generate && npx prisma migrate deploy` |
| `docker-compose.prod.yml` | `docker compose -f docker-compose.prod.yml up -d` |
| `nginx/emilestone.conf` | copy to sites-available, `sudo nginx -t && sudo systemctl reload nginx` |
| `.env` value | `pm2 delete emeal-server && pm2 start ecosystem.config.js --env production` |

---

# PART 4 — ROTATE ALL INTERNAL SECRETS (automated)

`deploy/rotate-secrets.sh` regenerates POSTGRES, REDIS, JWT×2, MINIO, BULL_BOARD_*,
writes them into `.env.production` **everywhere** (incl. `DATABASE_URL`), applies them
to Postgres (`ALTER USER`), recreates Redis/MinIO, cleanly restarts PM2, refreshes the
monitoring exporters, verifies health, and **auto-rolls-back if health fails**.

```bash
cd ~/eMeal-server
bash deploy/rotate-secrets.sh
```
**Expected tail:** `✅ ROTATION OK — {"status":"ok",...}`. All users must log in again
(JWT changed). Data is preserved. Old env saved at `.env.production.bak.<ts>`.

**NOT rotated by the script (rotate these manually — they live outside the server):**
- `TELEGRAM_BOT_TOKEN` → @BotFather → `/revoke` → paste new token into `.env.production`, then `pm2 delete && pm2 start`.
- `ALERT_SMTP_PASS` → change the `admin@emilestone.com` mailbox password in Hostinger → update `.env.production`.
- `GRAFANA_PASSWORD` → change inside Grafana (Profile) — its password lives in Grafana's own DB.
- `BACKUP_GPG_PASSPHRASE` → **do NOT rotate casually** — old encrypted backups can only be decrypted with the passphrase that made them.

---

# PART 5 — CHANGING THE BACKEND GITHUB REPO

If the backend moves to a different GitHub repo/branch, do this on the server:

```bash
cd ~/eMeal-server
# 1) point the local clone at the new remote
git remote set-url origin git@github.com:NEW_ORG/NEW_REPO.git
git remote -v                                  # verify

# 2) give the SERVER read access to the new repo:
#    the server authenticates over SSH using ~/.ssh/id_ed25519. Add its PUBLIC key as a
#    "Deploy key" (read-only) on the new GitHub repo (Settings → Deploy keys → Add):
cat ~/.ssh/id_ed25519.pub        # copy this line into the new repo's Deploy keys
#    (if no key exists:  ssh-keygen -t ed25519 -C "emeal-server-deploy"  then add the .pub)

# 3) test access + switch branch if it changed
git fetch origin
git checkout eMeal-server        # or the new branch name
git pull --ff-only origin eMeal-server

# 4) if the BRANCH name changed, update deploy.sh's default (or pass BRANCH=newname):
#    edit deploy/deploy.sh  → BRANCH="${BRANCH:-<new-branch>}"   (or run: BRANCH=<new> ./deploy/deploy.sh)

# 5) deploy from the new source
./deploy/deploy.sh
```
Verify: `git remote -v` shows the new repo; `git log -1` shows the expected commit;
`curl -s https://api.emilestone.com/api/v1/health` is `ok`.

---

# PART 6 — BACKUPS · RESTORE · DISASTER RECOVERY

- **Nightly** (cron 02:00): `backup.sh` → restore-verified `pg_dump` → **GPG-AES256
  encrypted** → MinIO mirror → `.env`/config tar (encrypted) → weekly/monthly tiers →
  rclone offsite (only `.gpg` leaves the server). Manual: `BACKUP_REMOTE=gdrive:eMeal-Backups ./deploy/backup.sh`.
- **List:** `ls -lh ~/backups/db/` · offsite `rclone ls gdrive:eMeal-Backups | tail`.
- **Restore an encrypted dump:**
  ```bash
  set -a; . ~/eMeal-server/.env; set +a
  gpg --batch --pinentry-mode loopback --passphrase "$BACKUP_GPG_PASSPHRASE" \
      -d ~/backups/db/emeal_<ts>.sql.gz.gpg | gunzip \
    | docker exec -i emeal_postgres psql -U emeal -d emeal_db
  ```
- **Test recovery anytime (quarterly drill):** `bash deploy/dr-drill.sh` → restores the
  latest encrypted backup into a throwaway DB, asserts data, drops it. Prod untouched.
- **Whole-server loss:** new VPS → PART 2 → restore `.env` from `~/backups/config` (or
  gdrive) → restore latest DB dump → `mc mirror` MinIO back → `./deploy/deploy.sh`.
- **After reboot:** everything auto-starts (Docker `unless-stopped` + PM2 systemd) —
  verified. No manual start needed.

---

# PART 7 — MONITORING · LOGS · ALERTING

- **Access (from your PC):** `ssh -L 3002:127.0.0.1:3002 -L 3001:127.0.0.1:3001 emeal@<ip>`
  → Grafana `http://localhost:3002` (datasources Prometheus + Loki auto-provisioned),
  Uptime-Kuma `http://localhost:3001`.
- **Metrics:** Prometheus scrapes node/cAdvisor/pg/redis exporters (`/targets` should be 5 up).
- **Logs:** Loki + Promtail ship all container + PM2 logs → Grafana → Explore → `{job="pm2-app"}`.
- **Alerts:** `deploy/healthcheck-alert.sh` (cron */5) → Telegram + Email if the API is
  down or a TLS cert is < 14 days from expiry. Test: `bash deploy/healthcheck-alert.sh test`.
- **Recommended add-on:** an off-server monitor (Healthchecks.io / UptimeRobot, free) to
  catch a *total* server-down that the on-server alerter cannot.

---

# PART 8 — SECURITY POSTURE
Key-only SSH (no root, no passwords) · UFW 22/80/443 · Fail2Ban sshd · TLS 1.2/1.3 +
HSTS · all data ports `127.0.0.1`-only · bcrypt(12) passwords · **encrypted offsite
backups** · per-IP API rate-limit (1000/min) · unattended OS security updates ·
`.env` chmod 600, never committed. Rotate all secrets with PART 4 before launch.

---

# PART 9 — FULL VERIFICATION COMMAND PACK
Run this after any migration / rotation / deploy to confirm everything is in place:
```bash
echo "── APP ──"; curl -s https://api.emilestone.com/api/v1/health; echo
echo "── PM2 ──"; pm2 status
echo "── DATA ──"; docker compose -f ~/eMeal-server/docker-compose.prod.yml ps
echo "── MONITORING ──"; docker compose -f ~/eMeal-server/deploy/monitoring/docker-compose.monitoring.yml ps
curl -s --max-time 5 'http://127.0.0.1:9090/api/v1/targets' | grep -o '"health":"[a-z]*"' | sort | uniq -c
echo "── SSH ──"; sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication'
echo "── FIREWALL ──"; sudo ufw status | head; sudo fail2ban-client status sshd | grep -E 'Currently|Total'
echo "── TLS ──"; sudo certbot certificates 2>/dev/null | grep -E 'Certificate Name|Expiry'
echo "── BACKUPS ──"; ls -lh ~/backups/db | tail -2; grep -E 'restore verification|backup OK' ~/backups/backup.log | tail -2
echo "── CRON ──"; crontab -l | grep -E 'backup|healthcheck'
echo "── PUBLIC PORTS (only 22/80/443) ──"; sudo ss -tlnp | grep -vE '127.0.0|::1' | awk '{print $4}'
```

---

# PART 10 — TROUBLESHOOTING (lessons learned)
| Symptom | Cause | Fix |
|---|---|---|
| 502 after secret change | PM2 cached old env | `pm2 delete emeal-server && pm2 start ecosystem.config.js --env production` |
| Redis `WRONGPASS` | app pw ≠ container requirepass | recreate redis (`docker compose up -d`) + clean PM2 start |
| `passwordauthentication yes` after harden | cloud-init `50-cloud-init.conf` wins | our drop-in is `00-emeal-hardening.conf` (sorts first) — re-run harden-server.sh |
| exporter `connection timed out` | bridge can't reach host loopback DB | exporters use `network_mode: host` (already set) |
| `.env` parse error | malformed line / special chars | values with `$ # ( )` must be single-quoted in `.env`; validate `docker compose config` |
| `reboot` "interactive auth required" | needs sudo | `sudo reboot` |

---

# PART 11 — NEVER DO
- Never expose 5432/6379/9000 publicly (keep `127.0.0.1`).
- Never commit `.env*`, `rclone.conf`, keys, or keystores.
- Never `docker compose down -v` (the `-v` deletes data volumes).
- Never hand-edit the prod DB schema — only `npx prisma migrate deploy`.
- Never bump Redis past 7.2 without a license review (BSD → SSPL).
- For `.env` changes use `pm2 delete && pm2 start`, not `pm2 reload`.
- Never rotate `BACKUP_GPG_PASSPHRASE` casually (orphans old backups).

---

# PART 12 — ADDITIVE OPS TOOLS & KNOWN LIMITATIONS

## New additive infra tooling (all optional, none touch app code)
| Task | Command | What it does |
|---|---|---|
| **Slow-query visibility** | `bash deploy/enable-pg-stat-statements.sh` | recreates PG with `pg_stat_statements` preloaded + creates the extension. Report later: `…enable-pg-stat-statements.sh report` (top-20 slowest statements) |
| **Storage orphan-sweep** | `bash deploy/minio-reconcile.sh` (dry-run) → `--apply` | lists/deletes bucket objects no DB row references AND older than `ORPHAN_MIN_AGE_DAYS` (7). Aborts if the DB ref list is empty (never wipes the bucket on a query error). Suggested monthly cron |
| **Authenticated load test** | `… grafana/k6 run - < deploy/loadtest-auth.js` (see file header) | logs in, measures Dashboard/Analytics p95 vs SLOs. Run from a **separate** box for a trustworthy 5000-VU number |
| **Pin DB pool** | edit `DATABASE_URL` in `.env.production` | append `&connection_limit=10&pool_timeout=20`, then `pm2 delete emeal-server && pm2 start ecosystem.config.js --env production` |

Apply the `connection_limit` to the live server:
```bash
cp -L ~/eMeal-server/.env.production ~/eMeal-server/.env.production.bak.$(date +%s)
# only if not already present:
grep -q 'connection_limit=' ~/eMeal-server/.env.production || \
  sed -i 's|\(^DATABASE_URL=.*emeal_db?schema=public\)|\1\&connection_limit=10\&pool_timeout=20|' ~/eMeal-server/.env.production
pm2 delete emeal-server && pm2 start ecosystem.config.js --env production
curl -s http://localhost:3000/api/v1/health; echo     # expect status:ok
```

## Clean‑slate reset before Play‑Store launch (⚠️ DESTRUCTIVE)
`deploy/reset-for-launch.sh` erases ALL test data (accounts, orgs, groups, meals, attendance,
events, notices, tokens) + all MinIO images + Redis, while **preserving the schema/migrations** —
so the first real signup creates the first org from scratch. Run it **once, right before publishing**,
never during normal operation. Safeguards: dry‑run by default · takes a verified backup first (refuses
to wipe if it fails) · needs `--confirm` **and** a typed phrase.
```bash
bash deploy/reset-for-launch.sh            # PREVIEW — shows what would be erased, changes nothing
bash deploy/reset-for-launch.sh --confirm  # EXECUTE — backs up, then wipes (type: ERASE ALL DATA FOR LAUNCH)
```
The erased test data is recoverable from `~/backups/db` (restore = PART 6).

## Known limitations (honest — what is NOT done)
| Area | Status | Note |
|---|---|---|
| Weekly-Menu / Billing caching | not done | app-layer (frozen) — would need backend change |
| App `/metrics` + cache-hit counter + tracing | not done | app-layer (frozen) |
| 5000-VU + per-endpoint load proof | tooling ready | needs an external load generator (`loadtest-auth.js`) |
| At-rest disk encryption (DB/MinIO volumes) | not done | LUKS if compliance requires; data is loopback + access-controlled |
| App-level multi-tenant pen-test | not done | isolation is app-enforced + tested, not RLS |
| High availability | single VPS (SPOF) | cost choice; auto-recovers on reboot; HA path in PART 1/SCALABILITY |

## Two watch-items (not breaks)
- **Redis (cache + queues + tokens) under a 768 MB cap, no `maxmemory` policy** — fine at current scale; watch `redis_memory_used_bytes` (redis-exporter). Do NOT add eviction (would drop queue/token keys).
- **Prisma pool scales with PM2 workers** — `instances: 'max'` + a bigger VPS = more workers × pool. Keep `workers × connection_limit < 100` (or PgBouncer).
