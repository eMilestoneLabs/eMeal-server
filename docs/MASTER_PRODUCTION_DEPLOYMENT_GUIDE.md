# MASTER PRODUCTION DEPLOYMENT GUIDE — MealAttend
> Smart Meal & Attendance Management SaaS. The single source of truth for taking the
> platform from its CURRENT STATE to public launch.
> Server: Contabo VPS 10 · IP 5.189.153.205 · Domain emilestone.com (Hostinger DNS).
> Hosts: api.emilestone.com (REST+WS) · cdn.emilestone.com (MinIO images).
> Status baseline: Requirements/Backend/Frontend/Contracts FROZEN · B1–B10 complete ·
> deployment + Play Store NOT done.
> DOCUMENTATION ONLY — no code, schema, or contract modified by this guide.
> Toolchain note: build/test/migrations were NOT executed in the authoring environment
> (no Node toolchain / DB / Flutter SDK); "verify on dev machine" steps are the proof gate.
> Every tool below is open-source, commercially usable, zero-license-cost, self-hostable,
> and Ubuntu-LTS compatible (see the Open-Source Compliance appendix).

---

# SECTION 1 — CURRENT STATUS AUDIT

| Dimension | Readiness | Evidence |
|---|---|---|
| Backend (code/features) | 100% | B1–B9 (256 tests recorded green 2026-06-12); B10 additive set in place (event lifecycle 423/409, 30/10 reminders, attending-only stats, WS events, member profile join); MinIO storage wired |
| Frontend (app logic) | 100% | All 4 role flows, 36 screens, ~68 routes, all 5 repos live-wired (mockAuthEnabled=false), realtime client |
| Contracts | 100% | 24/24 contract points matched; pagination/error/auth shapes; all Home.md WS events present |
| Deployment infra (built) | ~40% | Dockerfile, docker-compose.prod.yml (PG+Redis+MinIO), nginx/emilestone.conf, .env.production.example, deploy scripts exist — nothing provisioned/deployed yet |
| Play Store | ~30% | App id fixed (com.emilestone.mealattend), release signing config + INTERNET manifest fixed; keystore/listing/policy/AAB/testing pending |
| **Migration baseline** | 0% | `prisma/migrations/` empty — HARD BLOCKER |
| Verification run | 0% | `npm ci/build/test` not yet executed against the frozen code + new MinIO wiring |

Evidence files: docs/PERMANENT_MEMORY_CORE_DEVELOPMENT/FREEZE_AUDIT_REPORT.md,
IMPLEMENTATION_GAP_AUDIT.md, CONTABO_BACKEND_DEPLOYMENT_GUIDE.md, .github/workflows/emeal.yml.

Documented spec divergences (non-blocking, by decision/MVP): preference optional (not
mandatory), single meal image (not 3), bcryptjs (not Argon2), reminders 30/10 (Home.md
60/30 superseded by Student.md + UI). Monitoring stack + FCM push = future/non-blocking.

---

# SECTION 2 — WHAT IS FROZEN

## SAFE TO FREEZE (production-complete)
- Backend modules: Auth, Organizations, Groups, Meals, Weekly Schedules, Attendance,
  Analytics, Reports/Exports, Events, Event Guests, Notifications, Queues, Realtime,
  Audit Logs, Security middleware, Org isolation.
- Frontend modules: Student / Admin / Event Admin / Event Guest flows; theme system;
  all reusable premium components; realtime client; the 5 live repositories.
- DTOs: Create/Update DTOs for groups, meals, attendance, events, auth — validated.
- APIs: all `/api/v1/*` REST routes (auth, users, groups, meals, schedules, attendance,
  events, dashboard, exports, reports, health).
- Database schema: prisma/schema.prisma (incl. additive Event.closedAt/archivedAt).
- WebSocket contracts: attendance.marked.v1, attendance.overridden.v1, guest.joined.v1,
  guest.updated.v1, event.updated.v1, meal.updated.v1, meal.published.v1,
  schedule.published.v1, dashboard.updated.v1, analytics.updated.v1, member.blocked.v1.

## DO NOT CHANGE AFTER FREEZE
- Any JSON field name or shape returned to Flutter (locked fromJson).
- Pagination `{data,total,page,limit}`, error `{message,errors,statusCode}`,
  auth `{accessToken,refreshToken,expiresIn,user}`.
- Enum string values (GroupType incl. `factory_`, statuses), nested `attendanceWindow`.
- WebSocket event names / payload shapes (additive keys only).
- Repository method contracts consumed by the frontend.
Any change requires the 5-step compatibility audit (CLAUDE.md §3) and is additive-only.

---

# SECTION 3 — REMAINING BLOCKERS

| # | Blocker | Severity | Impact | Resolution | Effort |
|---|---|---|---|---|---|
| 1 | Prisma migration baseline missing | CRITICAL | Cannot `migrate deploy` to prod DB | `npx prisma migrate dev --name init_baseline` then commit | 30 min |
| 2 | No verification run of frozen code + MinIO wiring | CRITICAL | Unknown if build/tests pass after recent additive edits | `npm ci && npm run build && npm test && npm run test:e2e` | 1–2 h |
| 3 | DNS not configured | HIGH | No public hostnames | Hostinger A records api/cdn → 5.189.153.205 | 15 min + propagation |
| 4 | VPS not provisioned | HIGH | No runtime | setup-vps.sh (Docker/Node/PM2/Nginx/Certbot/UFW) | 1–2 h |
| 5 | SSL not issued | HIGH | No HTTPS/WSS | certbot --nginx (api + cdn) | 15 min |
| 6 | Android upload keystore not created | HIGH | Cannot sign release AAB | keytool + key.properties | 15 min |
| 7 | Play Console not set up | HIGH | No store listing/testing | Create app, listing, policy, data-safety | 0.5–1 day |
| 8 | MinIO bucket/public policy not set | MEDIUM | Meal images fail to load | mc mb + anonymous download on bucket | 15 min |
| 9 | Monitoring stack not deployed | MEDIUM | No metrics/alerts | Deploy Uptime Kuma + Prometheus/Grafana/Loki (Section 8) | 2–3 h |
| 10 | Coverage threshold not gated | LOW | CI passes on coverage drop | Add jest coverageThreshold (post-freeze, CI-only) | 30 min |
| 11 | Branded launcher icon missing | LOW | Ships stock Flutter icon | Replace mipmap icons | 30 min |
| 12 | Prometheus /metrics endpoint not in app | LOW | App-level metrics limited to infra exporters | Optional post-launch additive endpoint | deferred |

Blockers 1–2 are FREEZE-AND-SHIP gates. 3–8 are deployment/release mechanics. 9–12 are recommended/non-blocking.

---

# SECTION 4 — CONTABO VPS DEPLOYMENT (step-by-step)

> Reference: docs/PERMANENT_MEMORY_CORE_DEVELOPMENT/CONTABO_BACKEND_DEPLOYMENT_GUIDE.md.
> Each step: commands · why · verify · rollback. Run STAGE 0 (local) before touching the VPS.

### STAGE 0 (local, dev machine) — PROOF GATE
Commands:
```
cd D:\Hostel_Project\backend\eMeal-server
npm ci
npx prisma generate
npx prisma migrate dev --name init_baseline      # creates the baseline (Blocker 1)
npm run build && npm test && npm run test:e2e     # Blocker 2
git add -A && git commit -m "Production baseline + B11 infra" && git push origin main
```
Why: proves the frozen code + MinIO wiring compile and the migration exists.
Verify: `npx prisma migrate status` → 0 pending; tests green.
Rollback: `git restore --staged . && git checkout -- .` (changes are additive).

### Step 1 — Choose Contabo VPS 10
Already provisioned: Contabo VPS 10, IP 5.189.153.205, Ubuntu 24.04 LTS.
Verify: `ssh root@5.189.153.205` connects. Rollback: n/a.

### Step 2 — Domain (Hostinger)
Domain emilestone.com already owned in Hostinger. No purchase needed.
Verify: domain visible in Hostinger DNS zone editor.

### Step 3 — Configure DNS (Hostinger)
Add A records (TTL 300): `api` → 5.189.153.205 ; `cdn` → 5.189.153.205.
Verify: `nslookup api.emilestone.com` and `nslookup cdn.emilestone.com` → 5.189.153.205.
Rollback: delete the A records.

### Step 4 — Initial Ubuntu setup (as root)
```
apt update && apt upgrade -y
timedatectl set-timezone UTC
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
adduser emeal && usermod -aG sudo emeal
```
Why: patched base, UTC (all timestamps stored UTC), swap for build headroom, non-root user.
Verify: `free -h` shows swap; `id emeal` shows sudo. Rollback: `swapoff /swapfile; deluser emeal`.

### Step 5 — SSH hardening
```
# from your PC: ssh-copy-id emeal@5.189.153.205
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```
Why: key-only login, no root SSH. Verify: new `ssh emeal@...` works with key; password login refused.
Rollback: re-enable the two settings, restart ssh (keep a root session open while testing).

### Step 6 — Firewall (UFW)
```
sudo apt install -y ufw
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable
```
Why: only SSH/HTTP/HTTPS exposed (PG/Redis/MinIO stay localhost). Verify: `sudo ufw status`.
Rollback: `sudo ufw disable`.

### Step 7 — Fail2Ban
```
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```
Why: blocks brute-force SSH. Verify: `sudo fail2ban-client status sshd`. Rollback: `systemctl disable --now fail2ban`.

### Step 8 — Docker
```
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker emeal && newgrp docker
```
Why: runs PG/Redis/MinIO containers. Verify: `docker run --rm hello-world`. Rollback: `apt remove docker-ce`.

### Step 9 — Docker Compose
Bundled as the `docker compose` plugin with modern Docker. Verify: `docker compose version`.

### Step 10 — Node.js 20 LTS
```
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 20 && nvm alias default 20
```
Why: NestJS runtime. Verify: `node -v` → v20.x. Rollback: `nvm uninstall 20`.

### Step 11 — Git
```
sudo apt install -y git
git clone <YOUR_GIT_REMOTE> /opt/emeal-server   # sudo mkdir + chown emeal first
```
Verify: repo present in /opt/emeal-server. Rollback: `rm -rf /opt/emeal-server`.

### Step 12 — PM2
```
npm install -g pm2
pm2 startup systemd -u emeal --hp /home/emeal   # run the printed sudo command
```
Why: cluster process manager + autostart. Verify: `pm2 -v`. Rollback: `pm2 unstartup systemd`.

### Step 13 — PostgreSQL (container)
Part of docker-compose.prod.yml. Start in Step 17. Bound to 127.0.0.1:5432, volume `postgres_data`.
Verify: `docker exec emeal_postgres pg_isready -U emeal`. Rollback: `docker compose ... stop postgres`.

### Step 14 — Redis (container)
Part of compose. `--requirepass` + `--appendonly yes` (persistence). 127.0.0.1:6379, volume `redis_data`.
Verify: `docker exec emeal_redis redis-cli -a "$REDIS_PASSWORD" ping` → PONG.

### Step 15 — MinIO (container)
Part of compose. 127.0.0.1:9000 (S3) + 9001 (console), volume `minio_data`.
After up, create the bucket (Step in Section 7). Verify: `docker logs emeal_minio` healthy.

### Step 16 — Environment variables
```
cd /opt/emeal-server
cp .env.production.example .env && chmod 600 .env
for v in PG REDIS JWT_A JWT_R MINIO; do openssl rand -hex 32; done   # paste into .env
nano .env   # set all CHANGE_ME; DATABASE_URL must match POSTGRES_*; STORAGE_CDN_URL=https://cdn.emilestone.com
```
Why: secrets, never committed. Verify: `grep -c CHANGE_ME .env` → 0. Rollback: re-edit .env.

### Step 17 — Backend deployment
```
docker compose -f docker-compose.prod.yml up -d
npm ci && npm run build
pm2 start ecosystem.config.js --env production && pm2 save
```
Verify: `curl http://localhost:3000/api/v1/health` → {status:ok,db:ok,redis:ok}; `pm2 status`.
Rollback: `pm2 delete emeal-server`; `docker compose ... down` (data persists in volumes).

### Step 18 — Prisma migrations
```
npx prisma migrate deploy        # applies the committed baseline (NOT migrate dev)
npx prisma migrate status        # 0 pending
```
Why: provisions schema on prod DB. Verify: tables exist (`docker exec emeal_postgres psql -U emeal -d emeal_db -c "\dt"`).
Rollback: restore from pg_dump (Section 5) — never hand-edit prod schema.

### Step 19 — Nginx
```
sudo apt install -y nginx
sudo cp nginx/emilestone.conf /etc/nginx/sites-available/emilestone
sudo ln -s /etc/nginx/sites-available/emilestone /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```
Why: reverse proxy + WebSocket upgrade for api/cdn. Verify: `nginx -t` OK; `curl -I http://api.emilestone.com` → 301.
Rollback: `rm /etc/nginx/sites-enabled/emilestone && systemctl reload nginx`.

### Step 20 — SSL (Certbot, Let's Encrypt)
```
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.emilestone.com -d cdn.emilestone.com
sudo systemctl status certbot.timer
```
Why: free auto-renewing HTTPS/WSS. Verify: `curl https://api.emilestone.com/api/v1/health` OK.
Rollback: `certbot delete --cert-name api.emilestone.com`.

### Step 21 — Monitoring
See Section 8 (Uptime Kuma + Prometheus + Grafana + Loki). Verify: dashboards load; health probe green.

### Step 22 — Backups
See Section 5 (nightly pg_dump cron) + Section 7 (MinIO mirror) + rsync offsite.
Verify: a backup file appears in /opt/backups after the first cron run.

### Step 23 — Health verification (public)
```
curl https://api.emilestone.com/api/v1/health
curl -X POST https://api.emilestone.com/api/v1/auth/login -H "Content-Type: application/json" -d '{"identifier":"...","password":"..."}'
# WebSocket: confirm wss://api.emilestone.com upgrades (101).
```
Verify: health ok; login returns tokens + expiresIn:900. THE BACKEND IS LIVE.

---

# SECTION 5 — PRODUCTION DATABASE (PostgreSQL 16)

- Setup: container from docker-compose.prod.yml, localhost-bound, volume `postgres_data`.
- Users: single app role `emeal` (from POSTGRES_USER); no superuser exposure; app connects via DATABASE_URL.
- Passwords: 64-char random (`openssl rand -hex 32`), stored only in `.env` (chmod 600), never committed.
- Backups (nightly cron, as emeal):
```
sudo mkdir -p /opt/backups && sudo chown emeal:emeal /opt/backups
crontab -e
# 0 2 * * * docker exec emeal_postgres pg_dump -U emeal emeal_db | gzip > /opt/backups/emeal_$(date +\%Y\%m\%d).sql.gz 2>>/opt/backups/backup.log
```
- Restore:
```
gunzip -c /opt/backups/emeal_YYYYMMDD.sql.gz | docker exec -i emeal_postgres psql -U emeal -d emeal_db
```
- Retention: keep 30 daily; weekly copy off-server via rsync (`rsync -az /opt/backups/ user@backup-host:/emeal/`).
- Pre-migration: always `pg_dump` before `migrate deploy`.

---

# SECTION 6 — REDIS 7

- Persistence: `--appendonly yes` (AOF) + volume `redis_data`; survives restarts.
- Auth: `--requirepass $REDIS_PASSWORD` (localhost-bound; not exposed via UFW).
- Restart strategy: `restart: unless-stopped` in compose; data restored from AOF on boot.
- Responsibilities (infra only, no permanent business data): refresh-token families, rate
  limiting, websocket scaling/adapter, attendance dedup, BullMQ backend.
- Monitoring: redis_exporter (Section 8) → Grafana; `docker exec emeal_redis redis-cli -a $REDIS_PASSWORD info`.

---

# SECTION 7 — MINIO (object storage, S3-compatible)

- Buckets: `emeal-images` (meal images). Key pattern `org/{orgId}/meals/{mealId}/{ts}.{jpg|png}`.
- Create + public read (objects served via cdn.emilestone.com):
```
source /opt/emeal-server/.env
docker run --rm --network host minio/mc sh -c "\
  mc alias set local http://localhost:9000 $MINIO_ACCESS_KEY $MINIO_SECRET_KEY && \
  mc mb -p local/$MINIO_BUCKET && \
  mc anonymous set download local/$MINIO_BUCKET"
```
- Public URLs: StorageService returns `${STORAGE_CDN_URL}/${key}` = https://cdn.emilestone.com/org/.../x.jpg
  (Nginx proxies cdn.emilestone.com → 127.0.0.1:9000).
- Uploads: backend POST /meals/:id/image (FileInterceptor, ≤200KB, JPEG/PNG) → MinIO → persists imageUrl.
- Backups: `mc mirror local/emeal-images /opt/backups/minio/` in cron; rsync offsite. Volume `minio_data`.

---

# SECTION 8 — MONITORING (100% free / open-source)

All self-hosted, zero license. Deploy as an additive monitoring docker-compose (no app code change).

## 8.1 Uptime Kuma (uptime + alerts)
```
docker run -d --restart=unless-stopped -p 127.0.0.1:3001:3001 \
  -v uptime-kuma:/app/data --name uptime-kuma louislam/uptime-kuma:1
```
Add HTTP monitor → https://api.emilestone.com/api/v1/health (expect 200, JSON status:ok).
Configure free alert channels (email/Telegram/Discord webhook). Proxy via Nginx (status.emilestone.com) if desired.

## 8.2 Prometheus + exporters (metrics)
Compose services (bind 127.0.0.1): prometheus, node-exporter (host CPU/RAM/disk),
cAdvisor (containers), postgres-exporter, redis-exporter.
prometheus.yml scrapes: node-exporter:9100, cadvisor:8080, postgres-exporter:9187, redis-exporter:9121.
> App-level /metrics: the app code is FROZEN and has no prom-client endpoint. Infra exporters
> above cover host/DB/Redis/container metrics with zero code change. An app /metrics endpoint
> is an optional POST-LAUNCH additive enhancement — not required for launch.

## 8.3 Grafana (dashboards)
```
docker run -d --restart=unless-stopped -p 127.0.0.1:3002:3000 \
  -v grafana:/var/lib/grafana --name grafana grafana/grafana-oss:latest
```
Add Prometheus + Loki as data sources; import community dashboards 1860 (Node Exporter),
9628 (Postgres), 763 (Redis), 893 (Docker/cAdvisor). grafana-oss = AGPL, free, commercial-OK.

## 8.4 Loki + Promtail (logs)
Loki stores logs; Promtail ships PM2/Pino JSON logs (/home/emeal/.pm2/logs + docker json logs)
to Loki; view in Grafana Explore. All free/OSS.

Verify: Uptime Kuma green; Grafana shows host/DB/Redis/container metrics + logs.

---

# SECTION 9 — CI/CD (GitHub Actions — free for the repo)

Workflow `.github/workflows/emeal.yml` already implements the full pyramid + release gate:
- Code Quality: integrity, lint, tsc typecheck, governance.
- Hygiene: madge (circular), jscpd (duplication), knip (dead code).
- Security: CodeQL, Semgrep (OSS rules), Gitleaks, Trivy, npm audit, OSV-Scanner, license-checker.
- Feature tests (per feature) + consolidated Unit tests + coverage artifacts.
- Export verification (real XLSX/CSV), Build & Compile (tsc + nest + Docker image).
- Sanity, Smoke (real PG+Redis), Integration (real PG+Redis), Performance (load + RSS/CPU/GC).
- Release Gate: one required status; green only if every stage passed.

Release/deploy workflow (recommended, add as additive `.github/workflows/deploy.yml`):
on push to main → run tests → SSH to VPS → `cd /opt/emeal-server && ./deploy/deploy.sh`
(pg_dump backup → git pull → compose up → npm ci → build → prisma migrate deploy →
pm2 reload → health check). Uses appleboy/ssh-action (OSS) + GitHub repo secrets (VPS_HOST/USER/SSH_KEY).
Recommended CI hardening (post-freeze, CI-only): add jest coverageThreshold; switch
smoke/integration/perf from `prisma db push` to `migrate deploy` once the baseline is committed.

---

# SECTION 10 — FRONTEND PRODUCTION

- Production env (already set): EnvConfig._production.apiBaseUrl = https://api.emilestone.com/api ;
  wsBaseUrl = wss://api.emilestone.com ; mockAuthEnabled = false ; verbose logging off.
- API base URL: served behind HTTPS via Nginx + Certbot.
- Release mode build:
```
flutter pub get && flutter analyze && flutter test
flutter build appbundle --release --dart-define=APP_ENV=production
```
- Signing (already scaffolded in android/app/build.gradle.kts — falls back to debug if absent):
```
keytool -genkey -v -keystore android/upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
cp android/key.properties.example android/key.properties   # fill storePassword/keyPassword/keyAlias/storeFile
```
- Keystore safety: upload-keystore.jks + key.properties are gitignored; back them up securely
  forever (losing the upload key blocks future updates unless using Play App Signing recovery).
- App identity: applicationId com.emilestone.mealattend; INTERNET permission in main manifest (fixed).
- Recommended: replace stock launcher icon with branded MealAttend icon (all densities + adaptive).

---

# SECTION 11 — PLAY STORE RELEASE

1. Privacy Policy: host a page at https://emilestone.com/privacy (collected data: name, email,
   phone, age, gender, attendance records; camera used for QR scanning; no ads; no third-party
   data sale). Required URL in Play Console.
2. Data Safety form: declare data collected (personal info: name/email/phone; app activity:
   attendance), encryption in transit (HTTPS), user can request deletion. No advertising ID.
3. Permissions: INTERNET, CAMERA (QR), POST_NOTIFICATIONS, SCHEDULE/USE_EXACT_ALARM,
   RECEIVE_BOOT_COMPLETED, VIBRATE — justify camera (QR group join) and exact alarms
   (attendance reminders) in the listing.
4. Account Deletion: provide an in-app + web route to request account/data deletion
   (Play requires a deletion URL, e.g. https://emilestone.com/delete-account). Back it with
   the existing soft-delete; document the process.
5. App Content: content rating questionnaire, target audience (not children), ads = none,
   target API level (latest required by Play).
6. Internal Testing: create app → upload signed AAB → add internal testers → smoke test on real devices.
7. Closed Testing: wider tester group; run the full B10 integration checklist against the
   live API (login, QR join, attendance in/out-of-window→423, event close→423, meal-type
   delete-in-use→409, weekly menu, image upload, exports, realtime).
8. Open Testing (optional): public beta to gather feedback/crash data.
9. Production Rollout: staged rollout (e.g. 10% → 50% → 100%); monitor crashes/ANRs in
   Play Console vitals; halt/rollback track if regressions appear.

---

# SECTION 12 — GO-LIVE CHECKLIST

Backend / infra:
[ ] STAGE 0 local: npm ci + build + test + e2e green
[ ] Prisma baseline created and committed; migrate status 0 pending
[ ] DNS api/cdn → 5.189.153.205 resolve
[ ] VPS hardened (key-only SSH, UFW, Fail2Ban, swap, UTC)
[ ] Docker + Node20 + PM2 installed
[ ] .env filled (unique 64-char secrets; JWT access≠refresh; chmod 600)
[ ] compose up: postgres + redis + minio healthy
[ ] MinIO bucket emeal-images created + public-read
[ ] npm ci + build; prisma migrate deploy (0 pending)
[ ] pm2 cluster running + pm2 save + startup
[ ] Nginx config valid + reloaded
[ ] Certbot SSL issued for api + cdn; auto-renew timer active
[ ] https health = {status:ok,db:ok,redis:ok}
[ ] https login returns tokens + expiresIn:900
[ ] wss WebSocket upgrade works through Nginx
[ ] meal image upload returns cdn.emilestone.com URL
[ ] Monitoring: Uptime Kuma + Grafana dashboards live
[ ] Nightly pg_dump cron + MinIO mirror + offsite rsync verified
[ ] pm2-logrotate configured

Frontend / Play:
[ ] Upload keystore created + backed up; key.properties filled
[ ] flutter analyze + test pass
[ ] Release AAB built (--dart-define=APP_ENV=production), signed with upload key
[ ] Branded launcher icon (recommended)
[ ] On-device B10 integration checklist passed against live API
[ ] Privacy policy + account-deletion URLs live on emilestone.com
[ ] Data Safety + content rating + permissions justified
[ ] Internal → Closed testing green
[ ] Production staged rollout started; Play vitals monitored

---

# SECTION 13 — POST-LAUNCH OPERATIONS

Week 1:
- Watch Play vitals (crashes/ANRs), Uptime Kuma alerts, pm2 logs, Grafana host/DB/Redis.
- Confirm nightly pg_dump + MinIO mirror are producing files; test one restore.
- Triage early bug reports; hotfix via deploy/deploy.sh (zero-downtime pm2 reload).

Week 2:
- Review slow queries (postgres-exporter / pg_stat_statements); add indexes only via additive migration.
- Tune Nginx rate limits + PM2 max_memory_restart from real traffic.
- Expand closed→open testing or increase production rollout %.

Ongoing — Monitoring: Grafana dashboards + Uptime Kuma + Loki log search; alert channels active.
Backups: 30-day daily retention, weekly offsite; quarterly restore drill.
Bug fixes: branch → CI green (release gate) → deploy.sh → verify health → monitor.
Scaling: PM2 already cluster (all cores); scale vertically on Contabo, or add a second app
node + shared Redis (Socket.IO Redis adapter already in place) before DB read replicas.
Security: keep certbot auto-renew; run npm audit / Trivy / OSV in CI; rotate JWT secrets on
incident; review audit logs; apt unattended-upgrades for OS patches.
Deferred additive enhancements (post-launch, contract-safe): FCM remote push (firebase-admin),
User.defaultMealPreference column, app-level Prometheus /metrics endpoint, Argon2 migration,
multi-image meals, mandatory-preference toggle.

---

# APPENDIX — OPEN-SOURCE & COMMERCIAL-USE COMPLIANCE

Every component is open-source, commercially usable at zero license cost, self-hostable,
actively maintained, and Ubuntu 24.04 LTS compatible:
- Infra: Ubuntu Server LTS, Docker (Apache-2.0), Docker Compose, Nginx (BSD), Certbot/Let's Encrypt.
- Runtime: Node.js 20 LTS, PM2 (AGPL/free).
- Data: PostgreSQL (PostgreSQL License), Redis 7.2 (BSD-3 — pinned; avoids the post-7.4 RSAL/SSPL
  relicensing. Drop-in OSS alternative if ever needed: Valkey, BSD-3), BullMQ (MIT).
- Storage: MinIO (AGPL-3.0 — self-host/commercial use allowed).
- Monitoring: Prometheus (Apache-2.0), Grafana OSS (AGPL-3.0), Loki (AGPL-3.0), Uptime Kuma (MIT),
  exporters node/postgres/redis/cAdvisor (Apache-2.0).
- Security: CodeQL (free for the repo), Semgrep CE (LGPL/OSS rules), Gitleaks (MIT), Trivy
  (Apache-2.0), npm audit, OSV-Scanner (Apache-2.0).
- Testing: Jest (MIT), Supertest (MIT), k6 (AGPL-3.0) for load testing.
- CI/CD: GitHub Actions (free tier for the repo), appleboy/ssh-action (MIT).
- Docs: Markdown / GitHub Wiki. Backups: pg_dump, mc mirror, rsync.
No commercial-only, enterprise-only, trial, usage-limited, or proprietary tool is used.
The architecture is deployable and maintainable indefinitely with zero software-license cost.
Note: Redis is pinned to 7.2 (BSD); if your policy requires a fully OSI-license future, Valkey
(BSD-3) is a drop-in replacement with no code change.

---

# FINAL OUTPUT

- Deployment Readiness: ~40% (all infra files authored + CI ready; nothing provisioned/deployed; 2 hard gates open).
- Play Store Readiness: ~30% (app id/signing/manifest fixed; keystore/listing/policy/AAB/testing pending).
- Estimated Days To Launch: 5–8 working days of effort (Day 1: local verify + migration baseline;
  Day 2: VPS provision + deploy + SSL; Day 3: monitoring + backups + hardening; Day 4: keystore +
  icon + AAB + on-device integration test; Days 5–8: Play Console setup + internal/closed testing +
  staged rollout). Add Google review calendar time (often 1–7 days) on top.
- GO / NO-GO: **NO-GO right now** — blocked by (1) Prisma migration baseline and (2) the
  build/test verification run. **Conditional GO** the moment those two clear: backend code,
  frontend app, and contracts are frozen and complete; everything else is mechanics covered by
  this guide. Recommended path: clear Blockers 1–2 today → deploy backend (Section 4) → build +
  submit to Internal Testing (Sections 10–11) → staged production rollout.
