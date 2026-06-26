// eMeal k6 load test — proves API capacity + SLOs under concurrency.
// Targets the app DIRECTLY on localhost:3000 (bypasses Nginx rate-limit) so we
// measure real app throughput. /health exercises the full stack (app + DB + Redis).
//
// Run (Docker, no install needed), from the server:
//   docker run --rm --network host -v "$PWD/deploy:/s" grafana/k6 run /s/loadtest.js
// Scale up:   add  -e MAX1=500 -e MAX2=1000 -e MAX3=5000   (defaults below)
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const TARGET = __ENV.TARGET || 'http://localhost:3000/api/v1/health';
const errorRate = new Rate('errors');

export const options = {
  stages: [
    { duration: '30s', target: Number(__ENV.MAX1 || 100) },   // ramp to 100 VUs
    { duration: '1m',  target: Number(__ENV.MAX2 || 500) },   // ramp to 500 VUs
    { duration: '1m',  target: Number(__ENV.MAX3 || 1000) },  // ramp to 1000 VUs
    { duration: '30s', target: 0 },                           // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<300'],   // target: p95 under 300ms
    errors:            ['rate<0.01'],   // target: <1% errors
  },
};

export default function () {
  const res = http.get(TARGET);
  errorRate.add(!check(res, { 'status is 200': (r) => r.status === 200 }));
}
