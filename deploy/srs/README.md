# SRS End-to-End Validation Suite

Validates the MealAttend backend against the **664 SRS requirements**, plus
performance, memory-leak soak, and 100+ security probes — against the **live**
server, with **real HTTP / real responses**. It changes **no application code
and no infrastructure**, and is **read-only by default** (write flows are
opt-in and self-cleaning).

## Honest coverage (no fake green)

| Method | Requirements | How validated |
|---|---:|---|
| **API** | 526 | Real HTTP assertions: positive, negative, RBAC, tenant-isolation. |
| **PERF** | 48 | Latency p50/p95/p99, throughput/concurrency, SLO gates. |
| **SECURITY** | 19 | 100+ probes: authn, RBAC, IDOR, injection, headers, rate-limit. |
| **DEVICE** | 71 | Flutter/UI/offline behaviors — **cannot** be proven by curl. Emitted as a **manual checklist** to run on the phone; recorded as `MANUAL`, never `PASS`. |

A backend script physically cannot exercise on-device UI, navigation, offline
mode, branding, or image rendering. Those 71 are enumerated and traced so the
certificate is truthful about what was and wasn't machine-verified.

## Run it (on the VPS, from `~/eMeal-server`)

```bash
ADMIN_EMAIL='...'   ADMIN_PASS='...' \
STUDENT_EMAIL='...' STUDENT_PASS='...' \
ADMIN2_EMAIL='...'  ADMIN2_PASS='...' \
EDGE='https://your-domain' \
bash deploy/srs/run.sh
```

Optional env: `BASE` (default `http://localhost:3000/api/v1`), `PERF_SAMPLES`
(30), `PERF_CONC` (20), `SOAK_REQUESTS` (2000), `WRITE_TESTS=1` (enable the
self-cleaning signup→delete lifecycle checks).

Run a single layer standalone: `bash deploy/srs/functional.sh`,
`.../security.sh`, or `.../performance.sh`.

## Outputs (under `/tmp/emeal-srs-<timestamp>/`)

- `full-run.log` — everything, tee'd.
- `requirements.tsv` — every assertion → requirement-ID → status.
- `requirement-coverage.csv` — all 664 IDs with final status (PASS/FAIL/SKIP/
  MANUAL-PENDING/NOT-ASSERTED).
- `device-manual-checklist.txt` — the 71 on-device items to tick off manually.

## Notes

- **Memory soak** is a *leak signal*, not a formal proof: it flags a
  non-recovering RSS climb (>15% after settle) or a worker restart under load.
- `ADMIN2_*` (a second-org admin) is required for the tenant-isolation probes;
  without it those are skipped, not passed.
- `EDGE` (public HTTPS URL) is required for the security-header/TLS probes.
- Regenerate `manifest.tsv` after SRS edits: `SRS_ROOT=/path/to/SRS_DOCUMENTS
  bash deploy/srs/generate-manifest.sh` (committed static so the VPS needs no
  SRS files).
