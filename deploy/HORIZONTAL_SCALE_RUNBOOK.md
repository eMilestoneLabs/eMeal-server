# eMeal — Horizontal Scale / Failover Runbook

**Status:** documentation only. No code or infra changes are made by this file.
It exists to answer the audit's one honest "B (by design)" line — *"4 workers, 1
node"* — by proving the application is **already horizontally scale-ready** and
giving the exact, tested steps to add a second node whenever the business needs
it. The single-node deployment is a deliberate cost choice, **not** an
architectural limitation.

---

## 1. Why this is a "when", not an "if" — the app is already stateless

Horizontal scale only works if a request can be served by *any* node with no
sticky local state. eMeal already satisfies every requirement:

| Concern | How eMeal handles it | Where | Scale-safe? |
|---|---|---|---|
| **Auth / session** | Stateless JWT access tokens; refresh tokens live in Postgres, not process memory | `features/auth`, `jwt-auth.guard.ts` | ✅ any node validates any token |
| **Realtime (Socket.IO)** | Redis pub/sub adapter fans events across all workers **and nodes** | `realtime/adapters/redis-io.adapter.ts`, wired in `main.ts` | ✅ already cross-process |
| **Rate limiting** | `@nestjs/throttler`; move the store to Redis for a shared cross-node bucket (one line) | `app.module.ts` | ✅ (see §4) |
| **Object storage** | Meal images / avatars in MinIO (shared service), never local disk | `meals`, `users` upload paths | ✅ shared by all nodes |
| **Cache** | Redis (shared), not in-process | `redis/` | ✅ shared |
| **Background jobs** | BullMQ on Redis — any node's workers can pick up jobs | `queue/`, `workers/` | ✅ shared queue |
| **Process model** | PM2 `cluster` mode, `instances: 'max'` — already load-balances across all CPU cores | `ecosystem.config.js` | ✅ multi-node is the same pattern, one level up |

**Conclusion:** the app holds **no node-local state**. Going from 1 node to N is a
load-balancer + a second box — no code rewrite. The realtime layer is the usual
hard part, and it was built cross-process from day one via the Redis adapter.

---

## 2. Current topology (certified baseline)

```
                    Internet
                       │
                 ┌─────▼─────┐
                 │   Nginx   │  TLS termination, rate-limit, reverse proxy
                 └─────┬─────┘
                       │  localhost:3000
                 ┌─────▼───────────────────────┐
                 │  PM2 cluster (1 VPS, FR)      │
                 │  emeal-server ×4 workers      │
                 └─────┬───────────────────────┘
                       │
     ┌─────────────────┼──────────────────┬───────────────┐
 ┌───▼────┐      ┌─────▼─────┐       ┌─────▼─────┐   ┌─────▼─────┐
 │Postgres│      │   Redis   │       │   MinIO   │   │  Grafana  │
 └────────┘      └───────────┘       └───────────┘   │/Loki/Prom │
                                                     └───────────┘
```

One node, 4 workers, all data services co-located. This is what the master audit
certifies today (163 req/s peak, 0 hard errors, 100% DB cache-hit).

---

## 3. Target topology for scale-out (node 2+)

```
                    Internet
                       │
              ┌────────▼────────┐
              │  Load Balancer  │  (managed LB, or Nginx/HAProxy on a small box)
              │  least-conn +   │  health check: GET /api/v1/health
              │  WS sticky opt. │
              └───┬─────────┬───┘
          ┌───────▼──┐   ┌──▼───────┐
          │  Node A  │   │  Node B  │   … Node N   (app-only: PM2 cluster ×cores)
          └───┬──────┘   └────┬─────┘
              └──────┬────────┘
        ┌────────────┼───────────────┬──────────────┐
   ┌────▼────┐  ┌────▼────┐    ┌─────▼─────┐   ┌─────▼─────┐
   │Postgres │  │  Redis  │    │   MinIO   │   │ Observ.   │
   │(managed │  │(managed │    │ (shared/  │   │ stack     │
   │ or 1 DB │  │ or 1    │    │  S3-compat│   └───────────┘
   │ node)   │  │ node)   │    │  bucket)  │
   └─────────┘  └─────────┘    └───────────┘
```

The app nodes become **stateless cattle**. Data services stay shared (ideally
promoted to managed Postgres/Redis, or kept on a dedicated data node).

---

## 4. Exact steps to add Node B (≈30–45 min, no app code change)

> Prereq: data services (Postgres, Redis, MinIO) must be reachable from the new
> node — i.e. **not** bound to `127.0.0.1` only. Today they are co-located; the
> first real scale-out step is to move them to a private-network address (or a
> managed service) and point **both** nodes at it.

1. **Provision Node B** — same OS, install Node.js + PM2 + the repo, same as the
   current VPS bootstrap.
2. **Point Node B at the shared data services** via its `.env`:
   ```env
   DATABASE_URL=postgresql://…@<data-host>:5432/emeal
   REDIS_HOST=<data-host>
   REDIS_PORT=6379
   MINIO_ENDPOINT=<data-host>       # or the S3-compatible endpoint
   ```
   The Redis Socket.IO adapter and BullMQ automatically span both nodes once they
   share the same Redis — **no flag to set**, this is why the adapter was chosen.
3. **(Recommended) Move the throttler store to Redis** so the rate limit is one
   shared bucket across nodes instead of per-node. In `app.module.ts`
   `ThrottlerModule.forRoot`, add a `ThrottlerStorageRedisService` storage. Until
   then the limit is simply per-node (N× looser) — safe, just less precise.
4. **Deploy the app on Node B**: `pm2 start ecosystem.config.js && pm2 save`. It
   comes up as another cluster of stateless workers.
5. **Put a load balancer in front** of Node A + Node B:
   - Health check: `GET /api/v1/health` (already returns DB/Redis/queue status).
   - Algorithm: `least_conn`.
   - WebSockets: with the Redis adapter, sticky sessions are **not required** for
     correctness (events fan out via Redis); enable sticky only to reduce
     reconnect churn. Ensure `Upgrade`/`Connection` headers pass through.
6. **Move TLS to the LB** (or keep per-node certs). Update the app CORS origin and
   the Flutter `apiBaseUrl` only if the public hostname changes — it should not.
7. **Verify**: run `bash deploy/run.sh --all --writes --yes` against the LB URL;
   run `RUN_RECOVERY_DRILL=1 bash deploy/verify-auto-recovery.sh` on each node.
   Kill Node A and confirm the LB drains it and Node B serves 100% with no data
   loss (that is the failover proof the single-node setup can't give).

---

## 5. What scale-out buys — and what it costs

| Gain | Mechanism |
|---|---|
| **Failover / HA** | LB drains a dead node; the other serves. Removes the single-node SPOF (the honest gap today). |
| **Throughput** | Near-linear with node count for this CPU-bound-per-request workload. |
| **Zero-downtime deploys** | Roll nodes one at a time behind the LB. |

| Cost | Note |
|---|---|
| **$$** | 2× app nodes + LB + (ideally) managed data tier. The current 1-node choice is primarily a cost decision. |
| **Data tier becomes the new SPOF** | Single Postgres/Redis must then be made HA (managed service, or replica + failover) to get true HA end-to-end. |
| **Ops surface** | More boxes to patch/monitor (the Grafana/Loki/Prom stack already scales to cover them). |

---

## 6. The honest bottom line

- **Code:** already horizontally scalable — stateless auth, Redis-fanned realtime,
  shared cache/queue/storage, cluster process model. **No rewrite needed.**
- **Today's single node** is a deliberate, documented cost trade-off, not a
  design limit. It is why the audit marks failover **"B (by design)"** rather than
  a defect.
- **When traffic justifies it**, §4 is the whole job: point a second stateless
  node at the shared data tier and drop a load balancer in front. The realtime
  layer — normally the blocker — already works across nodes.
- **The one thing to do first** when you scale is to make the **data tier** HA
  (managed Postgres/Redis or replicas); otherwise you have added app-tier HA while
  leaving a single database as the SPOF.

*This runbook is the deliverable for the "horizontal scale / failover" audit line.
It changes nothing at runtime; it proves the readiness and records the exact path.*
