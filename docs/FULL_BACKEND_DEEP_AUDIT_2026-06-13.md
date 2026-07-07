# FULL BACKEND DEEP AUDIT — eMeal-server
> Comprehensive read-only audit of the backend against the frozen requirements +
> production runtime state. NO code/schema/contract modified. Date: 2026-06-13.
> Live in production: https://api.emilestone.com (verified {status:ok}).

## VERDICT
Production-grade and live. Architecture is clean, layered, contract-compliant, secure,
and observable. No blocking issues. Findings are limited to (a) intentional spec
divergences (documented, by decision), (b) deferred-by-freeze stubs (non-blocking), and
(c) optional ops polish. Nothing requires a fix to ship.

## 1. ARCHITECTURE & CODE HEALTH
- 145 source files, ~17,542 LOC. Largest file 811 lines (events.service) — no god-files.
- Layered: 13 top-level dirs (app, audit, common, config, features, logger, prisma,
  queue, realtime, redis, storage, workers) + 11 feature modules
  (auth, users, organizations, groups, meals, attendance, events, dashboard, exports,
  reports, notifications).
- Clean separation: Controller → Service → Repository → Prisma → Serializer → DTO.
  Controllers thin; business logic in services; data access in repositories.
- No `console.log`/`TODO`/`FIXME`/`debugger` in `src/` (prod-grade comments). 72 `: any`
  casts (Prisma/dynamic) — acceptable, not worth churn under freeze.
- Hygiene gates in CI: madge (0 circular), jscpd (~0.33% dup), knip (advisory).

## 2. DATA LAYER
- 15 Prisma models: Organization, User, RefreshToken, OtpRequest, Group, GroupMember,
  Meal, MealSchedule, ScheduleEntry, AttendanceRecord, Event, EventMealType,
  EventGuestParty, EventPerson, AuditLog. 6 enums (UserRole, GroupType, AttendanceStatus,
  AuditAction, MemberRole, MemberStatus).
- 51 @@index/@@unique — org/group/user/event/meal/date/joinCode all indexed (analytics +
  attendance + lookups optimized). N+1 fixed (per gap audit).
- Soft-delete (isActive / deletedAt) on groups, meals, schedules, events, users.
- Migration: baseline `0_init` generated + applied on prod (migrate deploy, 0 pending),
  committed to git (a3002ff). Future deploys use `migrate deploy`.
- createdAt/updatedAt on tables; UTC storage (Flutter converts to local).

## 3. API & CONTRACT COMPLIANCE
- Global prefix /api/v1; REST; DTO-validated (class-validator) with global
  ValidationPipe { whitelist, forbidNonWhitelisted, transform, 422 } — mass-assignment safe.
- Prisma models never returned raw — serializers/DTOs everywhere.
- Pagination contract {data,total,page,limit}; nested attendanceWindow; flat mealName/date;
  factory_/joinCode preserved; expiresIn integer. 24/24 frontend-contract points pass.
- Global exception filter → flat {message, errors, statusCode} at root (never nested);
  converts class-validator arrays to field maps. Business codes: 422 (validation/window),
  423 (window closed / event closed), 409 (meal type in use), 401/403/404.

## 4. SECURITY
- helmet (CSP/COEP in prod), compression, CORS (prod-restricted), secure headers.
- JWT access(15m)/refresh(7d) rotation + Redis token families + reuse detection.
- Argon2 NOT used — bcryptjs(rounds 12) (secure; spec divergence D3, documented).
- RBAC: JwtAuthGuard + RolesGuard + WsJwtGuard + EventAdminGuard.
- Rate limiting: global ThrottlerGuard + per-route @Throttle (login 10/min, OTP 5/min).
  `trust proxy = 1` set (commit d21bd95) → correct per-IP limiting behind Nginx.
- Multi-tenant isolation enforced in repositories (organizationId from JWT, never client);
  organization-isolation.spec guards it.
- Secrets in .env (gitignored, chmod 600); data services bound 127.0.0.1; UFW 22/80/443;
  Gitleaks/Trivy/Semgrep/CodeQL/npm-audit/OSV in CI.

## 5. REALTIME, QUEUES, WORKERS
- Socket.IO + @socket.io/redis-adapter (PM2-cluster-safe); WsJwtGuard handshake auth;
  rooms organization/group/user/event; versioned .v1 events (attendance.marked/overridden,
  guest.joined/updated, event.updated, meal.updated/published, schedule.*, dashboard.*,
  analytics.*, member.blocked). Additive-safe.
- 8 BullMQ workers, each a distinct @Processor: analytics-aggregation, attendance-reminder,
  notification, export, cleanup, schedule-publish, orphan, stale-token. No duplicate
  processors. Retry/idempotency handled.
- Reminders scheduled 30 + 10 min before window close (matches Student.md).

## 6. OBSERVABILITY & OPS
- Pino structured logging + request IDs + logging interceptor; audit logs on key actions.
- Health endpoint /api/v1/health → {status, database, redis, 5 queues}.
- Runtime: PM2 cluster (4) + systemd boot-persistence + zero-downtime reload (verified).
- Postgres+Redis+MinIO via docker-compose.prod.yml (localhost-bound, restart:unless-stopped).
- Nightly backups (pg_dump + MinIO mirror, 30-day retention) + pm2-logrotate. Reboot-safe.

## 7. TESTS & CI/CD
- 28 spec files (unit + e2e). Suites: services, serializers, validators, guards, utils,
  contract, pagination, org-isolation, phase-verification; smoke + system e2e on real PG+Redis.
- Pipeline (emeal.yml): quality (lint/typecheck/governance/integrity) + hygiene + CodeQL +
  Semgrep/Gitleaks/Trivy + dependency-health + per-feature tests + consolidated coverage +
  export verification + build (tsc+nest+docker) + sanity + smoke + integration + performance
  + release gate. npm ci passes (lockfile committed).
- CI gaps (optional, non-blocking): no coverageThreshold gate; smoke/integration use
  `prisma db push` (can switch to `migrate deploy` now baseline exists).

## 8. DOCUMENTED DIVERGENCES (by decision / MVP — non-blocking)
- D1 Meal preference: spec says mandatory-when-enabled; build keeps it OPTIONAL (UI authoritative).
- D2 Meal images: spec "up to 3"; build = single primary imageUrl (MVP). MinIO wired + working.
- D3 Password hash: spec Argon2; build bcryptjs(12) — secure.
- Reminders 30/10 (Student.md authoritative; Home.md 60/30 superseded).

## 9. DEFERRED-BY-FREEZE STUBS (post-launch, additive — non-blocking)
- FCM remote push: payload+worker exist, delivery LOG-ONLY (no firebase-admin send).
- User.defaultMealPreference: endpoint stub, no schema column.
- App-level Prometheus /metrics endpoint: infra exporters cover host/DB/Redis.

## 10. RISK REGISTER
| Risk | Severity | Status |
|------|----------|--------|
| Cross-org data leak | Critical | Mitigated (repo isolation + spec) |
| Brute-force on auth | High | Mitigated (per-IP throttle + trust proxy) |
| Backup on same disk only | Medium | OPEN — add offsite rsync (optional) |
| Redis bumped to 7.4+ (license) | Low | Pinned 7.2; documented in LICENSES.md |
| FCM push not delivering | Low | Local notifications work; FCM deferred |

## CONCLUSION
Backend is COMPLETE, secure, observable, contract-locked, and live in production with
zero blocking issues. Only open operational item: optional offsite backup. All else is
documented divergence or post-launch additive work. Safe to keep frozen.
