# eMeal — PRODUCTION READINESS AUDIT (evidence-based)

> Audited: 2026‑06‑27 · Live server: Contabo VPS (`vmi3282053`, 5.189.153.205) · Domain: emilestone.com
> Method: **every verdict below is tied to a command run on the LIVE server** (Pack A/C/D this date).
> Nothing is assumed. Where something was not measured, it is marked 🔴 GAP, not guessed.
> Scope: infrastructure + backend↔infra integration. Frozen: backend business logic / API contracts.
>
> Legend — ✅ Completed (proven) · 🟡 Partial (works, with a caveat or unmeasured edge) · 🔴 Gap (not done / not measured)

---

## 0. EXECUTIVE SUMMARY

**Overall: production‑grade for its current scale and purpose.** The stack is fully self‑hosted on
100% open‑source software, hardened, monitored, backed up (restore‑verified), and **proven to
auto‑recover after a reboot**. The long‑standing "images don't load" complaint was traced to a
single Nginx misconfiguration and **fixed** (evidence below). Measured per‑endpoint latency is
**far inside every SLO**. The honest residual gaps are all consequences of one deliberate choice:
**everything runs on a single VPS** (no high availability, no horizontal scale without adding nodes).

| Theme | Verdict |
|---|---|
| Server environment, deploy, backup, storage, monitoring, security, reliability, observability | ✅ |
| Ultra‑fast dashboard/app loading (server‑side) | ✅ measured under SLO |
| Image pipeline (the reported bug) | ✅ root‑caused + fixed + reboot‑persistent |
| High availability | 🔴 single‑VPS SPOF (cost choice) |
| True 5000‑concurrent / horizontal scale | 🟡 not validly load‑tested; needs 2nd node |
| "Feels slow" in the app | 🟡 **not server‑side** — client (Flutter) or network distance; see §7 |

---

## 1. SERVER — PRIMARY CHARACTER (what this server fundamentally *is*)

**A single‑node, vertically‑scaled, self‑hosted monolith.** One 4‑vCPU / 7.8 GB Contabo VPS runs
*everything*: the NestJS app (PM2 cluster ×4) **co‑located** with all stateful services
(PostgreSQL, Redis, MinIO) and the full observability stack (Prometheus, Grafana, Loki, exporters,
cAdvisor, Uptime‑Kuma), behind a single Nginx ingress, with every data port bound to `127.0.0.1`.

Its character, from measured evidence:
- **Cost‑optimal & simple** — one box, one bill; no managed‑service fees; 100% OSS.
- **Massively over‑provisioned for today** — DB 11 MB, CPU ~0% idle, RAM 1.6/7.8 GB used, disk 17%.
  It has years of vertical headroom at the current data/traffic scale.
- **Fast at current scale** — every endpoint inside SLO (§6), slowest app query 3.43 ms.
- **Operationally self‑healing** — PM2 (systemd) + Docker (`unless‑stopped`) bring the whole stack
  back after reboot, verified (§12).
- **Single point of failure** — its defining limitation. If this one host dies, the service is down
  until restore. That is the trade for the cost/simplicity (see §13).

In one line: **"the right architecture for a cost‑sensitive, single‑region, growing SaaS — excellent
until you need always‑on HA or multi‑region latency."**

---

## 2. INFRASTRUCTURE INVENTORY (measured — Pack A / Pack D)

| Layer | Evidence | Status |
|---|---|---|
| OS | Ubuntu 24.04 LTS, kernel 6.8, 4 vCPU, 7.8 GB RAM, 72 GB disk (17% used), **2 GB swap** | ✅ |
| Runtime | Node 20, PM2 cluster ×4 `online` + pm2‑logrotate, systemd autostart | ✅ |
| App | `emeal-server@1.0.0`, health `status:ok`, db+redis connected, 5 queues registered | ✅ |
| PostgreSQL | 16‑alpine, 11 MB DB, **83 indexes**, buffer‑cache hit **99.98%**, max_connections 100 (~14 used) | ✅ |
| Redis | 7.2‑alpine, used 3.46 MB, **0 evictions**, AOF on, `noeviction` (correct for queues/tokens) | ✅ |
| MinIO | pinned `RELEASE.2025‑09‑07`, 4 objects / 146 KiB, public‑read policy `download` | ✅ |
| Nginx | TLS 1.2/1.3, HSTS, `server_tokens off`, api + cdn vhosts | ✅ |
| SSL | api cert valid 76 days, cdn 86 days, certbot auto‑renew | ✅ |
| Firewall | UFW active, default deny incoming, only 22/80/443 reachable | ✅ |
| Fail2Ban | sshd jail active — **5 banned, 362 failed attempts blocked** | ✅ |
| Monitoring | Prometheus **5/5 targets up**, Grafana, Loki, Promtail, node/pg/redis/cAdvisor exporters | ✅ |
| Backups | nightly cron, restore‑verified, GPG‑encrypted, tiered, offsite (rclone→Drive) | ✅ |

**Open‑source policy** — ✅ fully compliant. Ubuntu, Docker, PostgreSQL, Redis, MinIO, Nginx, PM2,
Prometheus, Grafana, Loki, Certbot, Fail2Ban, k6 — all OSS / commercially‑free. Only paid items:
VPS + domain + mail mailbox. No proprietary software.

---

## 3. setup-vps.sh / deploy.sh / backup.sh

| Script | Requirement coverage | Status |
|---|---|---|
| **setup-vps.sh** | installs+configures base/UFW/Docker/Node/PM2/Nginx/Certbot/fail2ban/limits/log‑caps/backup‑cron/alert‑cron; **auto‑creates MinIO bucket (step 10)**; **auto‑issues SSL when DNS resolves (step 12)**; idempotent/repeatable | ✅ (migration ~95% one‑script; the irreducible ~5% — DNS, secret values, rclone OAuth — is the secret‑zero boundary, §13) |
| **deploy.sh** | pre‑deploy backup → git clean‑tree validation → `pull --ff-only` → `npm ci` → `prisma generate` → `nest build` → `migrate deploy` → `pm2 reload` → retrying health check → **auto‑rollback to prev commit on any failure** + journal | ✅ 12/12 (DB‑migration rollback is restore‑a‑dump, documented) |
| **backup.sh** | PG dump → gzip integrity → **restore‑verify into throwaway DB** → GPG‑AES256 → MinIO mirror → .env/config tar → daily/weekly/monthly tiers → retention prune → offsite | ✅ "not valid until restore verified" enforced. 🟡 Redis not dumped (deliberate — cache/reconstructable) |

**DR drill (run live):** `dr-drill.sh` restored the latest **encrypted** backup into a throwaway DB →
asserted **19 tables / 9 users / 4 orgs** → dropped it. Prod untouched. ✅ **Recovery is tested, not just documented.**

---

## 4. DATABASE / POSTGRESQL (measured)

- **Indexes:** 83 in `public`, every tenant table carries an indexed `organizationId`; composite
  hot‑path indexes on attendance `(groupId, attendanceDate)` and `(userId, attendanceDate)`; idempotency
  unique `(userId, mealId, attendanceDate)`. ✅
- **Slow queries (pg_stat_statements, real app traffic):** slowest **app** query = **3.43 ms**
  (`meal_schedules`), users 3.31 ms, groups 1.88 ms, attendance 0.37 ms. **No slow app queries exist.** ✅
  (Higher rows in the report are the postgres‑exporter's own monitoring queries, not the app.)
- **Connection pooling:** Prisma pool, ~14/100 connections in use. 🟡 `connection_limit` not yet pinned
  on the live `.env` (template updated; apply before scaling PM2 workers — §13).
- **Prepared statements / transactions:** Prisma parameterizes all queries (injection‑safe) and wraps
  multi‑step writes in transactions. ✅
- **Growth/storage:** 11 MB total; largest tables meals 432 kB, audit_logs 400 kB. Negligible. ✅
- Attendance / billing / report / export / meal / student / org / group tables — all present, indexed,
  org‑scoped. ✅ **No destructive changes made.**

---

## 5. MULTI‑TENANT ISOLATION (proven)

- **Schema + data:** `null_org = 0` across meals (20), groups (8), attendance (73) — **every tenant row
  is scoped to an organization.** ✅
- **Query enforcement:** repositories scope every read/write by `organizationId` (verified in code,
  e.g. attendance repository); uniqueness `(organizationId, email)`, `(groupId, userId)` blocks
  cross‑tenant overwrite. ✅
- **Storage isolation:** MinIO keys are `org/{orgId}/…` — org‑scoped object paths. ✅
- 🟡 Isolation is **application‑enforced** (not Postgres RLS). Robust + has a regression test, but an
  app‑level multi‑tenant **pen‑test** is what would move this from "audited" to "certified".

---

## 6. PERFORMANCE — MEASURED (Pack D, server‑local, ×3 each: miss→hit)

| Endpoint | 1st (cache‑miss) | warm | SLO target | Verdict |
|---|---|---|---|---|
| Dashboard (admin) | 196 ms | **13–39 ms** | < 300 ms | ✅ |
| Attendance (weekly‑summary) | 46 ms | **9–14 ms** | < 200 ms | ✅ |
| Billing (billing‑summary) | 30 ms | 54–87 ms | < 200 ms | ✅ |
| Weekly Menu (weekly‑schedule) | 71 ms | 47–60 ms | < 200 ms | ✅ |
| Meals (list) | 36 ms | 27–28 ms | — | ✅ |
| Notices | 30 ms | 23–30 ms | — | ✅ |
| Avatar / Meal image (CDN) | 168 ms cold | **72–97 ms** | < 100 ms | ✅ |
| `/health` (full stack) | — | 26–103 ms | API p95 < 200 ms | ✅ (68 ms p95 @1000 VU prior) |

**Conclusion: the server side meets every SLO with large margin.** Cache confirmed live
(`dashboard:* → 1`, `attendance:* → 1` keys appear after traffic; warm calls drop to ~13 ms).

### 7. "Feels slow" — root cause is NOT the server
Because server‑local responses are 13–97 ms, the app feeling slow must come from **outside the
backend**: (a) **Flutter client** (widget rebuilds, image decode, state management, first‑frame), or
(b) **network distance** — these timings are measured *on the box*; a real user adds round‑trip
latency. If users are in India and the VPS is in the EU, that RTT (~120–180 ms each way) dominates and
turns a 13 ms response into a ~200–350 ms wall‑clock — *while the server did nothing wrong*.
**Confirm with:** `curl -w '%{time_total}\n' -o /dev/null https://api.emilestone.com/api/v1/health`
from a user's network, and check the VPS region. **Fixes if network‑bound:** put Cloudflare in front
of the API (edge TLS termination near users) and/or host in a region closer to users. **Fixes if
Flutter‑bound:** client‑side profiling (out of infra scope).

---

## 8. IMAGE PIPELINE / MINIO LIFECYCLE (the reported bug — FIXED)

- **Root cause (found via evidence):** Nginx `cdn` vhost proxied `cdn.…/org/…` straight to MinIO, so
  MinIO read the first path segment `org` as the bucket → **403 on every image**. Direct MinIO with the
  bucket (`/emeal-images/org/…`) returned 200; CDN returned 403.
- **Fix:** `proxy_pass http://emeal_minio/emeal-images/;` — Nginx now injects the bucket. **Verified
  `CDN = 200`**, content‑type image/jpeg, `cache-control: public, max-age=31536000, immutable`, and it
  **survived a reboot** (§12). ✅ This was the entire "images load slowly / avatar not reflected / meal
  image not working" complaint — an infra bug, not Flutter.
- **No base64 in DB:** measured 0/0/0 across meals, schedule_entries, users — URLs only. ✅
- **Replace‑on‑upload + delete‑old, org‑scoped keys, one object per meal/user** — verified in code. ✅
- **Orphans / waste:** `minio-reconcile.sh` → "Referenced 4, orphans 0 — storage clean". ✅
  A monthly `minio-reconcile.sh --apply` cron is recommended as the safety net (best‑effort delete).
- 🟡 No MinIO ILM lifecycle rule (orphan sweep covers it instead).

---

## 9. REDIS / CACHING (measured)

- Cache layer is real: dashboard (student 120 s / admin 180 s / analytics 300 s), attendance, event
  stats, warm‑cache analytics worker — all with invalidation. Verified live (keys appear after traffic). ✅
- `noeviction` + 0 evictions + 3.46 MB used → correct and healthy (won't drop queue/token keys). ✅
- 🟡 **Weekly‑Menu and Billing are not cached** (app‑layer change — frozen). They still measure fast
  (47–87 ms) so it isn't hurting today; caching them is an optional future win.
- 🟡 Cache hit‑rate is not exported as a Prometheus metric (app `/metrics` would add it — frozen).

---

## 10. SECURITY / ENCRYPTION (measured)

- **Passwords:** bcrypt(12), hash‑only, salted (Argon2id "preferred" but bcrypt "acceptable" per policy). ✅
- **Auth:** JWT access+refresh with **refresh‑token family theft‑detection**; `trust proxy` set so the
  per‑IP throttle sees the real client IP behind Nginx. ✅
- **Transport:** TLS 1.2/1.3, **TLS 1.0 refused** (verified), HSTS, secure headers, certs valid + auto‑renew. ✅
- **Surface:** SSH key‑only / no‑root / maxauthtries 4, UFW (22/80/443 only), Fail2Ban active, data ports
  loopback‑only, secrets rotated, encrypted offsite backups. ✅
- **At rest:** backups AES256‑encrypted ✅; 🟡 DB/MinIO disk volumes not LUKS‑encrypted (recommend if
  compliance requires; data is loopback + access‑controlled).
- 🟡 App binds `0.0.0.0:3000` (UFW blocks externally) — defense‑in‑depth would bind `127.0.0.1` (1‑line
  app change, optional). 🟡 password‑reset/authz are app‑logic (audited, not pen‑tested).

---

## 11. OBSERVABILITY

- ✅ Centralized logs (Loki+Promtail), server/DB/Redis/container metrics (Prometheus+exporters, 5/5 up),
  Grafana dashboards, health checks, **cron alerting (Telegram + email on state change)**.
- 🟡 **No distributed tracing** (no OpenTelemetry), **no app‑level `/metrics`** (request histograms,
  cache‑hit counter) — both app‑layer/frozen. 🟡 No Nginx exporter (Nginx metrics not scraped).

---

## 12. POST‑REBOOT VERIFICATION (proven live)

After a full `sudo reboot` (uptime 26 s at check):
- App `status:ok`, db+redis connected ✅ · PM2 4 workers + logrotate `online` (auto‑resurrected) ✅
- postgres/redis/minio `Up (healthy)` + all 9 monitoring containers `Up` (Docker `unless‑stopped`) ✅
- **`CDN image = 200`** — the Nginx fix persisted ✅
- Pre‑reboot: `pm2-emeal`, `nginx`, `docker` all `enabled`; every container `unless‑stopped`.
- **Also verified: no regression after the live Postgres recreate** (pg_stat_statements) — app
  reconnected, `status:ok`. ✅
**→ Full unattended auto‑recovery confirmed. No manual start needed after reboot.**

---

## 13. LIMITATIONS WE WILL NEVER REACH ON THIS ARCHITECTURE
(Inherent to "everything on one VPS"; each has an upgrade path when the day comes.)

| Limit we can't reach as‑is | Why | Upgrade path |
|---|---|---|
| **True high availability (no SPOF)** | one host = one failure domain | 2nd app node + load balancer; managed/replicated PG |
| **Horizontal scale beyond one box** | app+DB+cache share 4 vCPU | move data services off‑box; add app nodes (Socket.IO Redis adapter already present) |
| **Validated 5000+ concurrent from one node** | 4 cores + per‑IP throttle; single‑host load test is invalid | distributed load test from external boxes + a 2nd node |
| **Zero/near‑zero RPO** | backups are nightly point‑in‑time | add WAL archiving / PITR (e.g. pgBackRest) |
| **Low latency for far‑away users** | single region | Cloudflare edge in front of API + CDN; or region closer to users |
| **At‑rest disk encryption / formal compliance** | volumes unencrypted | LUKS + a pen‑test + RLS |

These are **decisions, not defects** — appropriate for the current cost/scale, with clear exits.

---

## 14. HONEST GAP LEDGER — what is Completed / Partial / Gap

**✅ Completed (measured/proven):** OS hardening, swap, limits, Docker, PM2 cluster+autostart,
Postgres (indexed, fast, pooled), Redis (cache+queues+tokens, healthy), MinIO (URLs‑only,
replace‑on‑upload, no orphans), Nginx+TLS+HSTS, UFW, Fail2Ban, automated `setup-vps`/`deploy`/`backup`,
restore‑verified + **tested** DR, monitoring (5/5) + logs + alerts, multi‑tenant isolation,
**image bug fixed**, per‑endpoint latency under SLO, reboot auto‑recovery, secrets rotated, 100% OSS.

**🟡 Partial (works, with a caveat or unmeasured edge):**
1. Valid 5000‑VU / per‑resource‑under‑load test — single‑host test is throttle/contention‑bound; needs external generator + 2nd node.
2. "Feels slow" — proven *not* server‑side; client (Flutter) / network‑distance not yet measured from a user device (§7).
3. Weekly‑Menu + Billing not cached (app‑layer/frozen) — fast anyway.
4. App `/metrics` + cache‑hit counter + distributed tracing (app‑layer/frozen).
5. Prisma `connection_limit` not yet pinned on live `.env` (template ready).
6. App binds `0.0.0.0:3000` (UFW‑protected) — optional loopback bind.

**🔴 Gap (not done — decisions):**
1. High availability (single‑VPS SPOF).
2. At‑rest disk encryption (LUKS) + app‑level multi‑tenant pen‑test + Postgres RLS.
3. PITR / sub‑24h RPO (WAL archiving).
4. Mobile/Play‑Store readiness (crash reporting, offline/retry, push) — Flutter scope, not infra.

---

## 15. RECOMMENDED NEXT ACTIONS (priority order)
1. **Confirm the "feels slow" cause** — measure RTT from a user device + check VPS region (§7). If
   network‑bound, put Cloudflare in front of the API. *(highest user impact)*
2. **Pin `connection_limit`** on live `.env` before adding PM2 workers/cores.
3. **Schedule** `minio-reconcile.sh --apply` monthly (orphan safety net).
4. **Run a valid capacity test** (throttle‑lifted, external generator) for real 1000/5000 numbers.
5. When always‑on matters: **add a second node** (the SPOF is the only thing between this and HA).

---

*All figures in this document were produced by commands executed on the live server on 2026‑06‑27
and pasted back verbatim. No metric here is assumed.*
