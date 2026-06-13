# THIRD-PARTY LICENSE COMPLIANCE — MealAttend (Smart Meal & Attendance SaaS)
> Record of all third-party software used by the backend (`eMeal-server`), the
> frontend (`smart_meal_management`), and the production infrastructure, with the
> license of each and its commercial-use status.
> Prepared for audit / investor / legal review. Documentation only.
> Last reviewed: 2026-06-13.

## ATTESTATION (summary)
Every component used in this product is **open-source and free for commercial use at
zero license cost**. No proprietary, enterprise-only, trial, usage-limited, or
"non-commercial" software is used. The platform is deployable and maintainable
indefinitely without purchasing any software license.

Two components are licensed **AGPL-3.0** (MinIO, PM2). They are used **unmodified, as
self-hosted internal infrastructure** (object storage and process supervision). The
application code is **not** a derivative work of either and does **not** link them;
neither is offered to third parties "as a service." Therefore AGPL imposes **no
source-disclosure obligation** on the proprietary application. (Alternatives noted below
if an all-permissive stack is ever preferred.)

---

## 1. BACKEND DEPENDENCIES (npm) — all permissive
| Package | License | Commercial |
|---------|---------|-----------|
| @nestjs/* (common, core, jwt, passport, platform-express, platform-socket.io, swagger, throttler, websockets, bullmq, config) | MIT | ✅ |
| @prisma/client, prisma (dev) | Apache-2.0 | ✅ |
| @aws-sdk/client-s3 | Apache-2.0 | ✅ |
| firebase-admin | Apache-2.0 | ✅ (currently unused / log-only) |
| socket.io, @socket.io/redis-adapter | MIT | ✅ |
| bullmq, @bull-board/api, @bull-board/express | MIT | ✅ |
| ioredis | MIT | ✅ |
| passport, passport-jwt | MIT | ✅ |
| class-validator, class-transformer | MIT | ✅ |
| helmet, compression | MIT | ✅ |
| exceljs | MIT | ✅ |
| pino, pino-http, pino-pretty | MIT | ✅ |
| rxjs, reflect-metadata | Apache-2.0 | ✅ |
| bcryptjs | MIT | ✅ |
| ulid | MIT | ✅ |
| Dev tooling: jest, eslint, prettier, ts-node, ts-jest, supertest, @nestjs/cli | MIT | ✅ |
| typescript | Apache-2.0 | ✅ |

No GPL / AGPL / SSPL present anywhere in the backend npm dependency tree.

## 2. FRONTEND DEPENDENCIES (Flutter / pub.dev) — all permissive
| Package | License | Commercial |
|---------|---------|-----------|
| Flutter SDK, Dart | BSD-3-Clause | ✅ |
| go_router, flutter_secure_storage, shared_preferences, path_provider, share_plus, flutter_local_notifications, intl | BSD-3-Clause | ✅ |
| timezone | BSD-2-Clause | ✅ |
| dio, socket_io_client, equatable, flutter_animate, flutter_image_compress, cupertino_icons, qr_flutter | MIT / BSD | ✅ |
| pdf | Apache-2.0 | ✅ |
| image_picker | Apache-2.0 / BSD | ✅ |
| mobile_scanner | BSD-3-Clause (uses Google ML Kit barcode — free, no cost) | ✅ |
| google_fonts | Apache-2.0 (fonts themselves OFL/Apache) | ✅ |

## 3. INFRASTRUCTURE — all free commercial
| Component | License | Commercial | Note |
|-----------|---------|-----------|------|
| Ubuntu Server 24.04 LTS | Various FOSS | ✅ | |
| Docker / Compose | Apache-2.0 | ✅ | |
| Nginx | BSD-2-Clause | ✅ | |
| Certbot / Let's Encrypt | Apache-2.0 / free CA | ✅ | |
| PostgreSQL 16 | PostgreSQL License (permissive) | ✅ | |
| Redis **7.2** | **BSD-3-Clause** | ✅ | Pinned. See caveat C3. |
| MinIO | **AGPL-3.0** | ✅ | Self-hosted, unmodified. See caveat C1. |
| PM2 | **AGPL-3.0** | ✅ | Process supervisor. See caveat C2. |
| GitHub Actions, CodeQL (public repo), Semgrep CE, Gitleaks, Trivy, OSV-Scanner | MIT / Apache / LGPL / free | ✅ | CI/security |

---

## CAVEATS / FORWARD-LOOKING NOTES
**C1 — MinIO (AGPL-3.0):** free for commercial self-hosting; no obligation while used
unmodified as internal storage (app talks S3 API, not linked). All-permissive alternative
if ever desired: SeaweedFS (Apache-2.0).

**C2 — PM2 (AGPL-3.0):** free; runs beside the app as a supervisor, not linked into it.
Alternative: plain systemd units (no PM2).

**C3 — Redis pinned at 7.2 (BSD-3, true OSI).** Redis **7.4+ relicensed to RSALv2/SSPLv1**
(source-available, not OSI). Even then it remains free for self-hosted use, but to stay on
a guaranteed-OSI license **do not bump to redis 7.4/8 without review** — or migrate to
**Valkey** (BSD-3, Linux Foundation fork; drop-in, no code change).

**Firebase (future):** firebase-admin SDK is Apache-2.0; Firebase Cloud Messaging (if
enabled later) is a free Google service — no license cost.

---

## HOW TO REGENERATE THIS REPORT
Backend (machine-readable license inventory):
```
npx license-checker-rseidelsohn --production --csv > backend-licenses.csv
```
Frontend:
```
flutter pub deps --style=compact   # then review each package page on pub.dev for its license
```
CI also runs a license summary artifact (`dependency-health` job in .github/workflows/emeal.yml).
