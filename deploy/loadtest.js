// eMeal k6 load test — proves the API stays correct + fast under flood, and that
// the per-IP rate limiter protects it (rejecting excess with 429, never 5xx).
//
// Targets the app DIRECTLY on localhost:3000 (bypasses Nginx) so we measure the
// app itself. /health exercises the full stack (app + DB + Redis).
//
//   docker run --rm --network host -v "$PWD/deploy:/s" grafana/k6 run /s/loadtest.js
//   scale:  add  -e MAX1=500 -e MAX2=1000 -e MAX3=5000
//
// ── Why 429 is a PASS, not a failure ─────────────────────────────────────────
// k6 runs from ONE host = ONE source IP, so all VUs share a single per-IP throttle
// bucket (global limit ≈ THROTTLE_LIMIT/min). Past that rate the app correctly
// returns 429 (Too Many Requests). That is the limiter WORKING — a defense, not a
// defect. Real users arrive from many IPs, each with its own bucket, so this
// single-IP 429 ratio is NOT the app's user capacity.
//
// This test therefore certifies the two things that actually matter under flood:
//   1) ZERO hard errors — the app never 5xx's or drops connections, it only ever
//      serves (200) or politely throttles (429). Threshold: hard-error rate <1%.
//   2) Served requests stay fast — p95 latency of 200 (served, NOT throttled)
//      responses is under the SLO. Threshold: served_duration p95 <300ms.
// A separate `throttled` rate is recorded for visibility (no threshold).
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const TARGET = __ENV.TARGET || 'http://localhost:3000/api/v1/health';

// 200 = served, 429 = throttled: BOTH are healthy, expected outcomes under flood.
// Tagging them "expected" keeps k6's built-in http_req_failed = genuine failures
// only (5xx, timeouts, connection resets), which is what we threshold on.
http.setResponseCallback(http.expectedStatuses(200, 429));

const hardErrorRate = new Rate('hard_errors'); // neither 200 nor 429 → real fault
const throttledRate = new Rate('throttled');   // 429 → limiter engaged (visibility)
const servedDuration = new Trend('served_duration', true); // latency of 200s ONLY

export const options = {
  stages: [
    { duration: '30s', target: Number(__ENV.MAX1 || 100) },   // ramp to 100 VUs
    { duration: '1m',  target: Number(__ENV.MAX2 || 500) },   // ramp to 500 VUs
    { duration: '1m',  target: Number(__ENV.MAX3 || 1000) },  // ramp to 1000 VUs
    { duration: '30s', target: 0 },                           // ramp down
  ],
  thresholds: {
    // Genuine faults must stay under 1% — the app must never 5xx/drop under load.
    hard_errors: ['rate<0.01'],
    // Requests the app actually served (200s only — 429s excluded so fast
    // throttle responses can't flatter the number) must meet the SLO.
    served_duration: ['p(95)<300'],
    // Sanity: the built-in failure metric (now = hard faults only) also <1%.
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(TARGET);
  const served = res.status === 200;
  const throttled = res.status === 429;
  hardErrorRate.add(!served && !throttled);
  throttledRate.add(throttled);
  if (served) servedDuration.add(res.timings.duration);
  check(res, {
    'no hard error (200 or 429)': () => served || throttled,
    'served request meets SLO (<300ms)': () => !served || res.timings.duration < 300,
  });
}
