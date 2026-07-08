# OPUS DEVELOPMENT GUIDEBOOK — eMeal / MealAttend Platform

**Status: BINDING.** Every future feature implementation or bug fix MUST comply
with this guidebook. It is the long-form companion to
`D:\Hostel_Project\OPUS_COMMAND\DEVELOPMENT_GUARD.xml` (prepend that command to
every task; open this book when you need the *why* and the *patterns*).
Certified perf baseline lives in `docs/SERVER_HANDBOOK.md` PART 15.

---

## 0. The one law

> The platform is performance-certified (backend compute 9–18 ms/endpoint,
> 1000-VU p95 < 300 ms, cache-first instant UI, leak-free 5-day uptime).
> **Any change that adds a network wave, a query wave, a cache gap, a spinner,
> or an undisposed resource is a regression — even if the feature works.**

Deliver features *inside* the existing speed architecture, never around it.

---

## 1. Architecture map (what exists — reuse it, don't rebuild it)

### Backend (NestJS, `D:\Hostel_Project\backend\eMeal-server`, branch `eMeal-server`)
- **Layering:** controller → service → repository (Prisma). Serializers shape
  responses. Config via `registerAs` files in `src/config/` (env-driven, never
  hardcode).
- **Caching:** Redis read-cache on hot GETs; composite dashboards
  (`dashboard:admin:{org}`, `dashboard:student:{org}:{user}`); billing uses the
  **version-key scheme** — `bill:ver:{groupId}` bumped on every attendance /
  guest / adjustment write, embedded in the cache key.
- **Aggregates:** `GET /dashboard/admin/overview` composes a whole screen in
  one request (Promise.allSettled, fail-soft per section). Batch resolvers
  (e.g. `getEffectiveGroupsForMeals`, `findMembershipsForUserInGroups`) exist —
  use them instead of per-item lookups.
- **Async side-effects:** push (FCM collapse-tagged), bell notices, audit
  (HMAC-signed), realtime emits — ALL fire-and-forget (`void promise`), all
  `@Optional() @Inject(...)` so tests and degraded envs run without them.
- **Background work:** BullMQ queues + `system-default.scheduler` repeatable
  sweeps (attendance default, vacation, reminders, digests, event cleanup).
- **Workers must keep cache parity** with the request path when they write.

### Frontend (Flutter, `D:\Hostel_Project\frontend\eMeal`, branch `emeal`)
- **State:** per-screen ChangeNotifier providers created in
  `initState`/`didChangeDependencies`, disposed with the screen. ONLY the two
  dashboards are hoisted to their shells (their `_mealSummaries` are
  non-cacheable) — do not hoist anything else without a full lifecycle audit.
- **SWR cache:** `ResponseCacheService` (SharedPreferences, timestamped,
  pruned at boot). `CacheWarmer` prefetches on login.
- **Network:** `DioApiService` — HTTP/2 multiplexing (10-min warm idle), GET
  dedup, transient-only retry w/ backoff, 401-refresh interceptor.
- **Realtime:** `RealtimeService` singleton (Socket.IO, room re-join on
  reconnect, **lifecycle-paused in background** — never undo that).
- **Images:** `CachedPhoto` (disk cache, `cacheWidth` decode caps, thumb-first
  with session negative-cache); MinIO URLs only, never base64; new-upload bytes
  seeded via `ImageCacheSeeder`; decoded-image RAM capped via
  `EnvConfig.imageCacheMaxBytes` in `bootstrap.dart`.
- **Startup:** `bootstrap()` = synchronous wiring → `runApp` FIRST → all I/O
  after first frame, guarded + time-bounded. `/health` pre-warm opens the TLS
  connection during the splash. NEVER add awaited I/O before `runApp`.

---

## 2. Cache-key registry (shared truth — extend, never fork)

| Key | Written by | Read by |
|---|---|---|
| `admin_groups:{org}` (+`:all` archived) | Groups / Attendance / Billing / Meal-Config / Staff-Attendance loads; **write-through on archive/restore/delete** | every admin tab's group selector, group-detail resolve |
| `meal_config_meals:{org}:{group}` | Meal Config loads + mutations; group-detail Meals tab; CacheWarmer | Meal Config, group-detail Meals tab, planner bootstrap |
| `group_members:{org}:{group}` | member directory load + member mutations | directory, CacheWarmer |
| `admin_attendance:{org}:{group}:{y}-{m}-{d}` | attendance load | attendance tab |
| dashboards / menu / profile / attendance-history keys | their providers | same |

**Rules:** one key per dataset (the `meal_config_groups` duplicate was a bug —
unified 2026-07-08). Any mutation another screen displays must write through
the shared key **and** the returning screen must repaint-from-cache
(`await context.push(...)` → `repaintFromCache` → silent network refresh).
Keys are org/group/user-scoped; cleared on logout. Financial figures are NEVER
in this cache.

---

## 3. The seven golden patterns (copy these, don't invent)

1. **Cache-first load** — in `load()`: if state empty → set loading **sync**
   (first frame shows loader, never the empty state) → read cache → paint →
   network ALWAYS overwrites → write cache on success only.
2. **One-wave boot** — a screen may await at most ONE network wave before
   content paints. Start every fetch whose inputs are already known (nav param,
   cached selection) in the same wave: `final aF = repo.a(); final bF =
   repo.b(); final a = await aF; final b = await bF;`. Multi-step chains get a
   provider `bootstrap...()` (see `MealConfigProvider.bootstrapPlanner`) with
   local paint → parallel wave → reconcile.
3. **Optimistic mutation** — update in-memory + shared cache immediately, pop
   destructive/confirmed actions instantly, roll back + snackbar on the rare
   failure (archive/permanent-delete pattern).
4. **Fire-and-forget side-effects** — anything that isn't the response
   (push/audit/notice/emit/backfill) is `void`/`unawaited` with internal
   try/catch, and **checks a `_disposed` flag before `notifyListeners()`**.
5. **Backend read composition** — new screen data rides an existing query
   (add a `select` field), an existing `Promise.all`, or a new *aggregate*
   endpoint — never a new sequential await on a hot path.
6. **Backend write** — tx for multi-table, `createMany(skipDuplicates)` for
   bulk, invalidate the FULL cache set (incl. dashboard composites +
   `bill:ver`), audit + notify fire-and-forget, realtime emit to group rooms.
7. **Sweep/worker** — registered repeatable job (a method with no caller does
   NOT run), jobId via `QueueService.jobIdOf` (no `:`), idempotent
   (once-flags/skipDuplicates), org-TZ aware, cache parity, audited.

---

## 4. Crash-safety & long-term-stability rules (all currently satisfied — keep it that way)

- Repos return `Result` (Ok/Err) and never throw → `Future.wait` on repo calls
  cannot reject. Keep new repo methods on the Result contract.
- Every async continuation in a `State` checks `mounted`; in a provider checks
  `_disposed` before `notifyListeners()`.
- Every Timer/AnimationController/StreamSubscription/TextEditingController/
  FocusNode is cancelled/disposed; `removeListener` before `dispose`. (Sweeps
  2026-07-08: zero violations — new code must keep the count at zero.)
- No polling anywhere. Realtime + SWR silent refresh cover freshness. One-shot
  `Future.delayed` must be mounted-guarded.
- Unbounded growth is forbidden: SWR cache pruned at boot (`prune`),
  date-keyed caches age out, decoded-image RAM capped, thumb negative-cache is
  session-scoped and bounded by viewed URLs.
- Startup contract: a frame ALWAYS renders (`runApp` before any awaited I/O);
  session restore is local-first; network errors never log a user out (only
  server-confirmed 401/403 do).
- Backend: every external call has a timeout + graceful degradation; global
  exception filter; ValidationPipe whitelist+forbid (422); malformed
  date/id params rejected by regex BEFORE Prisma (400, never 500).

---

## 5. Security invariants (non-negotiable)

- `organizationId` from JWT only; every query org-filtered; group access
  verified before read/write; unknown/foreign id → 404, never 200-empty.
- Admin surfaces: `@UseGuards(RolesGuard)` + `@Roles(...ADMIN_ROLES)` —
  RolesGuard checks CURRENT DB role (60 s cache).
- State-changing flows re-check DB state at submit (archived group, blocked
  member, finalized period, join approval). No endpoint may bypass a guard the
  dedicated endpoint enforces.
- bcrypt for passwords AND OTPs; signed QR payloads; no secrets in logs or
  responses; attendance idempotency key `@@unique([userId,mealId,
  attendanceDate])` is untouchable.
- Money: billing engine = whole ₹; ledger = paise; conversion ONLY at
  `sumAdjustmentsByUser` + exports; option `priceDelta` paise→₹ at the mark
  path. Never create a new unit boundary without a comment.

---

## 6. Build & release rules

- Android release keeps **R8 + resource shrinking ON**
  (`android/app/build.gradle.kts` + `proguard-rules.pro`). A plugin broken by
  R8 gets a keep rule — never flip `isMinifyEnabled` off.
- Ship per-device: `flutter build apk --release --split-per-abi
  --dart-define=ENV=production` (arm64 ≈ 30 MB vs 83 MB universal).
- New image *types* on the backend: uploads auto-thumbnail; run
  `deploy/backfill-thumbnails.js --apply` on the VPS after adding a new bucket
  path family.
- Only open-source, commercial-safe dependencies; prefer what's already in
  `pubspec.yaml`/`package.json` before adding anything.

---

## 7. Mandatory verification protocol (run ALL before reporting done)

```
# Backend  (D:\Hostel_Project\backend\eMeal-server)
npx tsc --noEmit                # clean
npx jest --silent               # baseline 375/375, 38 suites — may rise, never fall

# Frontend (D:\Hostel_Project\frontend\eMeal)
flutter analyze lib             # 0 issues
flutter build apk --release --dart-define=ENV=production   # must build (R8 on)
```

Self-audit the diff against the checklist:
☐ zero new awaits-in-loops ☐ zero new hot-path query waves ☐ one-wave screen
boots ☐ cache-first + sync loader ☐ shared-key write-through on mutations
☐ fire-and-forget side-effects w/ `_disposed` guards ☐ org isolation on every
query ☐ additive API/schema only ☐ env-config for every new value ☐ dispose
parity ☐ no polling / background timers ☐ R8 still on.

After deploy (user runs): `deploy/benchmark-full.sh` (admin+student, p95 vs
SLO budgets — all rows 2xx, no CHECK!) and compare against Handbook PART 15.
Any SLOW row = investigate before closing. Live regressions of Pass 1–15
features are checked with `deploy/audit-pass11-13.sh` + feature smoke calls.

---

## 8. Known gotchas (each one shipped a real bug — read before coding)

- BullMQ `jobId` must not contain `:` → job silently never enqueued.
- `@Optional() dep: T | null` erases DI metadata → pair with explicit `@Inject`.
- Nested class-validator DTOs must be declared BEFORE the referencing class.
- `@IsNotEmpty` accepts whitespace → `@Transform(trim)` on names.
- `LoginDto` = `{identifier,password}` only (forbidNonWhitelisted → 422).
- Push `route` values must be REGISTERED role-prefixed paths
  (`/student/...`, `/admin/...`) — roleless routes 404 in-app.
- Phone clock is untrusted: attendance windows evaluate the server's
  `orgClockMinutes`/`orgDate`/`windowState` from `/meals/today`.
- flutter_secure_storage can lose the Keystore master key on APK update —
  never clear a session on a read *exception* (retry, fall back).
- `benchmark-endpoints.sh` (legacy) measured `/meals*` WITHOUT groupId =
  empty path; use `benchmark-full.sh` for real numbers.
- Planner drafts and billing figures are never SWR-cached (draft-clobber /
  money-staleness) — parallelize their fetches instead.

---

## 9. Audit/validation script rules (MANDATORY for every new script)

`deploy/run.sh` is the single audit entry point. Any new check — including
the FUTURE SRS module scripts (Modules 03+ following the Module 01/02
pattern) — must plug into it, not fork a new workflow.

1. **ZERO PRODUCTION IMPACT.** Audit scripts OBSERVE the golden baseline;
   they never modify application code, config, env, nginx, PM2, docker,
   schema, or infra. The baseline is the gold — scripts only assay it.
2. **Impact class is declared, not implied.** Read-only (RO) by default.
   Anything that creates data must be SELF-CLEANING (create → verify →
   delete/revert in the same run) and registered as WRITE so it only runs
   behind `--writes`. Heavy traffic = HEAVY behind `--load`.
3. **Standalone + registered.** Each script runs on its own
   (`bash deploy/<name>.sh`) AND is added to `deploy/run.sh` with ONE `reg`
   line (name, impact, description) + one case-arm in `run_module`.
4. **Accounts come from `deploy/srs/accounts.sh`** (2 admins + 2 students,
   env-overridable) — never hardcode credentials elsewhere; never create
   permanent accounts.
5. **Contract:** exit 0 = pass, 1 = advisory, ≥2 = fail. Print human-readable
   PASS/FAIL per check. Trim pasted whitespace from env inputs. On login
   failure print the HTTP status + body (never just "failed").
6. **Never bench an error path silently** — non-expected status codes must be
   flagged (`CHECK!`), or the timings become false evidence (this bug shipped
   twice). Always parameterize endpoints with REAL ids discovered at runtime.
7. **Gotchas that already bit us:** `/auth/login` = `{identifier,password}`
   only, throttled 10/min; `/attendance` takes fromDate/toDate (not `date`);
   `/attendance/meal-summary` needs `mealId+date`; `/exports/attendance`
   needs `groupId`; psql runs via
   `docker exec emeal_postgres bash -c 'psql -U "$POSTGRES_USER" …'`
   (no `postgres` role); redis needs `-a $REDIS_PASSWORD` from the HOST .env;
   k6 runs via `docker run --rm -i --network host -v "$PWD/deploy:/s"
   grafana/k6 run /s/<file>.js`.
8. **SRS module scripts** live in `deploy/srs/`, source `lib.sh` +
   `accounts.sh`, assert against `manifest.tsv` requirement IDs, and stay
   read-only unless `WRITE_TESTS=1`.
9. **Reports** go under `deploy/audit-reports/<timestamp>/` (never /tmp-only,
   never committed); the frozen infra scripts (deploy.sh, setup-vps.sh,
   backup.sh, harden-server.sh) are NEVER edited to accommodate an audit.
- DATABASE_URL carries `connection_limit=10&pool_timeout=20` — 4 PM2 workers
  × 10 = 40 connections, deliberately under Postgres max_connections=100.
  Never raise connection_limit without redoing that math (or add PgBouncer).
- No global `statement_timeout` is set — DELIBERATE: Prisma interactive
  transactions are already time-bounded (5 s default), all queries are
  indexed (9–18 ms measured), and a URL-level timeout would break long
  migrations/exports. If ever added, do it at the ROLE level for the app
  user only, never on the migration path.
