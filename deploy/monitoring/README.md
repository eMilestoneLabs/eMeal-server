# eMeal Observability Stack (Track C — optional, additive)

100% open-source, zero license cost, self-hosted. **Nothing here touches the
application, its data, or its contracts.** It is a separate Docker Compose
project you can add or remove at will.

## What it gives you
| Component | Port (localhost only) | Purpose |
|---|---|---|
| Prometheus | 9090 | metrics store + scraper |
| node-exporter | 9100 | host CPU / RAM / disk / network |
| cAdvisor | 8080 | per-container metrics (postgres, redis, minio) |
| postgres-exporter | 9187 | DB connections, slow queries, sizes |
| redis-exporter | 9121 | hit/miss, memory, keyspace |
| Grafana OSS | 3002 | dashboards |
| Uptime Kuma | 3001 | uptime monitoring + free alerts (email/Telegram/Discord) |

All ports bind to `127.0.0.1` and are additionally blocked from the public by UFW
(only 22/80/443 are open). Reach the UIs over an SSH tunnel.

## Install
```bash
cd ~/eMeal-server/deploy/monitoring
cp .env.monitoring.example .env && chmod 600 .env   # set POSTGRES_*/REDIS_PASSWORD (= app .env) + GRAFANA_PASSWORD
docker compose -f docker-compose.monitoring.yml up -d
docker compose -f docker-compose.monitoring.yml ps    # all healthy?
```

## Access (from your laptop)
```bash
ssh -L 3002:127.0.0.1:3002 -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 emeal@<server-ip>
```
- Grafana → http://localhost:3002 (admin / your GRAFANA_PASSWORD)
- Uptime Kuma → http://localhost:3001
- Prometheus targets → http://localhost:9090/targets (all should be **UP**)

## Grafana setup (one-time)
1. Add data source → Prometheus → URL `http://prometheus:9090` → Save & test.
2. Import community dashboards (Dashboards → Import → by ID):
   - **1860** Node Exporter Full (host)
   - **9628** PostgreSQL
   - **763** Redis
   - **14282** cAdvisor / container metrics

## Uptime Kuma setup (one-time)
- Add **HTTP(s)** monitor → `https://api.emilestone.com/api/v1/health` → expect 200.
- Add a second monitor for `https://cdn.emilestone.com` (a known image URL).
- Configure a free notification channel (email / Telegram / Discord webhook) for alerts.

## Alerting (Prometheus → optional)
Prometheus is pre-wired for metrics; add Alertmanager later if you want metric-based
alerts. For launch, Uptime Kuma's health-probe alerts cover availability.

## Resource note
On the 4-vCPU / 8 GB box this stack adds ~300–500 MB RAM. With swap now present
and ~6 GB free, there is ample headroom.

## Rollback / remove
```bash
docker compose -f docker-compose.monitoring.yml down        # stop (keep history)
docker compose -f docker-compose.monitoring.yml down -v     # stop + delete monitoring data
```
This never affects the app, DB, Redis, or MinIO.
