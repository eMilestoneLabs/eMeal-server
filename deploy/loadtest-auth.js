// eMeal AUTHENTICATED load test — measures the REAL "feels slow" endpoints
// (Dashboard / Analytics) under concurrency, with a JWT, against their SLOs.
// Complements loadtest.js (which only exercises /health).
//
// It logs in ONCE in setup(), then every VU reuses that token to hit the
// protected endpoints. Per-endpoint p95 is checked against the targets:
//   Dashboard < 300ms · Attendance/Analytics < 200–300ms
//
// ── Run from an EXTERNAL box (so the load generator does NOT share the API's
//    CPU — that is what makes a 5000-VU number trustworthy): ──────────────────
//   docker run --rm -i \
//     -e BASE_URL=https://api.emilestone.com \
//     -e LOGIN_EMAIL='admin@yourorg.com' -e LOGIN_PASSWORD='••••••' \
//     -e MAX1=100 -e MAX2=500 -e MAX3=1000 \
//     grafana/k6 run - < deploy/loadtest-auth.js
//   # push the ceiling:  -e MAX3=5000   (run from a 2nd VPS, not the app server)
//
// If your login uses phone/identifier instead of email, pass the whole body:
//   -e LOGIN_JSON='{"identifier":"+9199...","password":"••••"}'
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PREFIX = `${BASE}/api/v1`;

// per-endpoint latency trends (so each SLO is checked independently)
const tStudent  = new Trend('ep_dashboard_student', true);
const tAdmin    = new Trend('ep_dashboard_admin', true);
const tAnalytics= new Trend('ep_analytics_attendance', true);
const errs = new Rate('errors');

export const options = {
  stages: [
    { duration: '30s', target: Number(__ENV.MAX1 || 100) },
    { duration: '1m',  target: Number(__ENV.MAX2 || 500) },
    { duration: '1m',  target: Number(__ENV.MAX3 || 1000) },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    ep_dashboard_student:    ['p(95)<300'],
    ep_dashboard_admin:      ['p(95)<300'],
    ep_analytics_attendance: ['p(95)<300'],
    errors:                  ['rate<0.01'],
    http_req_failed:         ['rate<0.01'],
  },
};

// ── setup(): authenticate once, hand the token to every VU ───────────────────
export function setup() {
  const body = __ENV.LOGIN_JSON
    ? __ENV.LOGIN_JSON
    : JSON.stringify({ email: __ENV.LOGIN_EMAIL, password: __ENV.LOGIN_PASSWORD });

  const res = http.post(`${PREFIX}/auth/login`, body, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login failed (HTTP ${res.status}): ${res.body}`);
  }
  // tolerate common token shapes
  let j = {};
  try { j = res.json(); } catch (e) { /* noop */ }
  const token =
    j.accessToken || j.access_token ||
    (j.data && (j.data.accessToken || j.data.access_token)) ||
    (j.data && j.data.tokens && j.data.tokens.accessToken) ||
    (j.tokens && j.tokens.accessToken);
  if (!token) throw new Error(`could not find access token in login response: ${res.body}`);
  return { token };
}

export default function (data) {
  const h = { headers: { Authorization: `Bearer ${data.token}` } };

  group('dashboard', () => {
    // student dashboard (works for student/member roles)
    let r = http.get(`${PREFIX}/dashboard/student`, h);
    tStudent.add(r.timings.duration);
    errs.add(!check(r, { 'student 2xx/403': (x) => [200, 403].includes(x.status) }));

    // admin dashboard (works for admin roles)
    r = http.get(`${PREFIX}/dashboard/admin`, h);
    tAdmin.add(r.timings.duration);
    errs.add(!check(r, { 'admin 2xx/403': (x) => [200, 403].includes(x.status) }));

    // attendance analytics
    r = http.get(`${PREFIX}/dashboard/analytics/attendance`, h);
    tAnalytics.add(r.timings.duration);
    errs.add(!check(r, { 'analytics 2xx/403': (x) => [200, 403].includes(x.status) }));
  });

  sleep(1); // model think-time so VUs ≈ concurrent users, not a tight hammer
}
