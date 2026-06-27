# eMeal — Infrastructure Upgrade (Tracks A · B · C)

> Additive, production-grade infrastructure hardening on top of the FROZEN stable
> baseline (backend `b522143` / `eMeal-server`). **No frontend, no backend business
> logic, no API/DB contracts, no application features were changed.** Every change
> below is infrastructure-only, idempotent where applicable, and reversible.
> Server: Contabo VPS · Ubuntu 24.04.4 LTS · 4 vCPU · 7.8 GB RAM · 72 GB disk.

---

## 1. Audit evidence (live server, captured read-only)

| Area | Finding | Source |
|---|---|---|
| Swap | **0 B** (docs claimed 2 GB) | `swapon --show` |
| Timezone | **Europe/Berlin (+0200)** (docs claimed UTC) | `timedatectl` |
| SSH | **PermitRootLogin yes · PasswordAuthentication yes** (docs claimed key-only/no-root) | `sshd -T` |
| fail2ban | status not reported (likely inactive) | `fail2ban-client status` |
| ulimit (nofile) | **1024** (low for a WebSocket server) | `ulimit -n` |
| Containers | no mem/cpu limits, no log caps (LIMIT = full 7.7 GiB) | `docker stats` |
| MinIO image | `minio/minio:latest` (unpinned) | `docker ps` |
| Backups | daily dump + offsite (gdrive) + MinIO mirror **working**; no restore-verify, no secret backup | `crontab`, `~/backups`, logs |
| CDN cache | **already correct** — `Cache-Control: public, max-age=31536000, immutable` | `curl -I cdn` |
| Monitoring | none deployed | `docker ps` |
| Unattended-upgrades | enabled | `systemctl is-enabled` |
| DB | PostgreSQL 16.14, 11 MB, 18/100 conns, shared_buffers 128 MB | `psql` |
| Health | 95–170 ms, all containers healthy 13 days | `curl`, `docker ps` |

**Two pre-audit assumptions corrected by evidence:**
1. **CDN image caching was already live** (immutable, 1-year). The "images load slowly"
   symptom is **not** an infra cache gap — it is Flutter-side (out of scope) or first-load
   network latency. **No infra change made to image caching** beyond locking the live
   behavior into the repo config so a rebuild can't regress it.
2. **Infra is not the current bottleneck.** At 11 MB DB / 4 vCPU / ~6 GB free RAM /
   ~0–8 % CPU, there is large headroom; "feels slow" complaints are not infra-bound today.

---

## 2. What changed, per file (all additive)

### Track A — live-server hardening — `deploy/harden-server.sh` (NEW)
Idempotent, re-runnable, lockout-safe. Adds: 2 GB swap (+ `vm.swappiness=10`), UTC,
`nofile` 65535, fail2ban sshd jail, **guarded** SSH hardening (only disables
password/root login if a working `authorized_keys` is present — otherwise skips and
warns), unattended-upgrades.
- **Run:** `bash deploy/harden-server.sh` (dry run: `DRY_RUN=1 bash deploy/harden-server.sh`)
- **Rollback:** each step documents its own reversal inline (e.g. `sudo rm /etc/ssh/sshd_config.d/99-emeal-hardening.conf && sudo systemctl reload ssh`).
- **Verify:** `swapon --show`; `timedatectl | grep Time`; `ulimit -n`; `sudo fail2ban-client status sshd`; `sudo sshd -T | grep -E 'permitroot|passwordauth'`.

### Track B — repo infrastructure-as-code
| File | Change | Rollback |
|---|---|---|
| `deploy/setup-vps.sh` | Rewritten into a **complete idempotent provisioner** (packages, UFW, Docker, Node, PM2+logrotate, rclone, swap/UTC/limits/fail2ban/SSH via harden-server.sh, journald+Docker log caps, dirs, compose, nginx, backup cron). A blank VPS → production-ready in one run. | It only fills gaps; re-running is safe. To undo a piece, see that tool's standard removal. |
| `deploy/backup.sh` | Added gzip **integrity check**, **restore verification** into a throwaway DB (prod untouched), **config/.env backup**, **weekly/monthly tiers**, tiered retention. Backups now fail loudly if unrestorable. | Previous script is in git history; `git revert` the commit. Output dirs unchanged. |
| `deploy/deploy.sh` | Added git-clean validation, **automatic rollback** to the prior commit on failed build/migrate/health, **deploy journal** (`deploy/deploy.log`), retrying health check, and made the pre-deploy backup **blocking** (override `SKIP_BACKUP=1`). | `git revert`; behavior is a superset of the old flow. |
| `docker-compose.prod.yml` | Added per-service **log caps** + generous **memory backstops** + **image pinning via env** (`MINIO_IMAGE`, etc.) + opt-in `REDIS_EXTRA_ARGS`. No behavior change until you opt in to pinning. | Revert the file; or `docker compose up -d` with old file. **Applying recreates containers once (brief restart; volumes persist).** |
| `nginx/emilestone.conf` | Moved `limit_req_zone` to valid http context, locked in the live **immutable cache** headers, made it **self-contained/copy-safe** (references existing certs), `server_tokens off`, TLS via certbot options. | Keep a copy of the live file first: `sudo cp /etc/nginx/sites-available/emilestone ~/emilestone.bak`. Restore + `nginx -t` + reload. |
| `ecosystem.config.js` | Fixed PM2 log keys (`out_file`/`error_file` — were ignored as `output`/`error`); corrected the stale `deploy:` reference block. | Revert; cosmetic + log-path fix only. |
| `.gitattributes` (NEW) | Forces LF on `*.sh` so shebangs work on Ubuntu. | n/a |

### Track C — observability — `deploy/monitoring/` (NEW, optional)
Prometheus + node/cAdvisor/postgres/redis exporters + Grafana OSS + Uptime Kuma.
Separate compose project, all ports `127.0.0.1`-bound (UFW also blocks them), zero app
change. See `deploy/monitoring/README.md`. **Rollback:** `docker compose -f docker-compose.monitoring.yml down`.

---

## 3. Recommended apply order (you run these on the VPS)

> Do this in a maintenance window. Keep your current SSH session OPEN throughout.

```bash
cd ~/eMeal-server
git pull origin eMeal-server          # get these infra changes

# ── Track A: hardening (idempotent, lockout-safe) ──
#   FIRST ensure key login works: from your PC, ssh-copy-id emeal@<ip> (if not already).
DRY_RUN=1 bash deploy/harden-server.sh   # preview
bash deploy/harden-server.sh             # apply
#   Then TEST a NEW ssh session before closing this one.

# ── Track B: backups (no recreate needed) ──
VERIFY_RESTORE=1 bash deploy/backup.sh    # confirms restore verification passes

# ── Track B: nginx (back up live first) ──
sudo cp /etc/nginx/sites-available/emilestone ~/emilestone.bak
sudo cp nginx/emilestone.conf /etc/nginx/sites-available/emilestone
sudo nginx -t && sudo systemctl reload nginx   # if -t fails: restore ~/emilestone.bak

# ── Track B: data-services compose (RECREATES containers — brief restart) ──
#   Optional: pin MinIO to the running release first:
#     echo "MINIO_IMAGE=minio/minio:$(docker exec emeal_minio minio --version | awk '{print $3}')" >> .env
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps    # all healthy?

# ── Track B: deploy.sh + ecosystem (next deploy uses new flow) ──
pm2 reload ecosystem.config.js --update-env       # picks up fixed log keys

# ── Track C: monitoring (optional) ──
cd deploy/monitoring && cp .env.monitoring.example .env && chmod 600 .env  # fill creds
docker compose -f docker-compose.monitoring.yml up -d
```

---

## 4. Disaster recovery (now achievable from this repo + backups)

| Failure | Recovery |
|---|---|
| **Whole VPS lost** | New VPS → `bash deploy/setup-vps.sh` → restore `.env` from `~/backups/config/` (or gdrive) → `docker compose -f docker-compose.prod.yml up -d` → restore latest DB dump (below) → `mc mirror` MinIO back from `~/backups/minio` → `./deploy/deploy.sh`. |
| **Database** | `gunzip -c ~/backups/db/emeal_<ts>.sql.gz \| docker exec -i emeal_postgres psql -U emeal -d emeal_db` (every dump is restore-verified nightly, so this is known-good). |
| **MinIO objects** | `mc mirror ~/backups/minio local/emeal-images` (mirror is taken nightly + offsite). |
| **Redis** | Ephemeral (tokens/queues/cache). AOF auto-restores on container restart; no action needed. |
| **Bad deploy** | Automatic — `deploy.sh` resets to the prior commit, rebuilds, reloads on any failure. DB rollback (only if a migration was destructive) = restore the pre-deploy dump. |
| **Offsite** | Google Drive `gdrive:eMeal-Backups` keeps full history (rclone copy, never deletes). |

DR is now **testable**: the nightly backup proves restorability; do a quarterly full
restore drill onto a scratch VPS.

---

## 5. Intentionally NOT changed (already correct / out of scope)

- **CDN image caching** — already `immutable` + 1-year on the live server (evidence §1).
- **Image replace-on-upload / org isolation** — `storage.service.ts` already writes
  org-scoped keys (`org/{orgId}/…/{timestamp}.{ext}`), returns URLs (never base64), and
  deletes the old object on replace. Timestamped keys give automatic cache-busting →
  updates are visible immediately via a new URL. No infra change needed.
- **Passwords** — bcrypt (rounds 12) is an accepted baseline per the freeze docs; Argon2
  is a deferred app-level change (out of infra scope).
- **DB tuning** — at 11 MB / 18 connections, defaults are fine. `shared_buffers` tuning is
  an additive option for later (Week 2 ops), not needed now.
- **Scalability** — PM2 is already cluster (4 workers = 4 cores); Socket.IO Redis adapter is
  in place for horizontal scale. Current headroom is large. Scale vertically on Contabo
  first, then add a second app node before DB read replicas. No change required now.

## 6. Performance / load posture
- Current health p50 ≈ 0.1 s; targets (API p95 < 200 ms, dashboard < 300 ms) are realistic
  given current headroom. The infra changes here do not alter request-path latency
  (they add safety/observability), so **no regression** is possible from them.
- Load testing (k6, AGPL/free) is recommended pre-scale: ramp 100→500→1000 VUs against
  `/health` + a read endpoint and watch Grafana (CPU/mem/DB conns). This is a measurement
  task to run once monitoring (Track C) is up; it changes no code.
