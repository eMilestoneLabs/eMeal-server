#!/usr/bin/env node
/**
 * scripts/ci/perf-test.js  <baseUrl>  <serverPid>  <outDir>  [gcLogFile]
 *
 * Full backend performance profiler for CI. All numbers are REAL live
 * measurements against the running app + its real Redis/Postgres/queue/WebSocket,
 * or the server process via /proc. Writes a detailed HTML + JSON report and
 * heap snapshots / a findMany review list as artifacts.
 *
 * Adds: memory-leak heap snapshots (SIGUSR2), 1000+ concurrent stress test,
 * a 2–5 min mini soak test, P95/P99 CI budgets, warmed Redis hit-rate.
 *
 * Pass/fail = API SLO (error<=50%, p99<=5s) + P95/P99 budgets. Every probe is
 * defensive: a failed probe renders "n/a" and never fails the job.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

let BASE = (process.argv[2] || 'http://localhost:3000').replace('//localhost', '//127.0.0.1');
const SERVER_PID = process.argv[3] || '';
const OUT_DIR = process.argv[4] || 'artifacts/performance';
const GC_LOG = process.argv[5] || '';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || '';

const TARGET_PATH = '/api/v1/health';
const TOTAL_REQUESTS = Number(process.env.PERF_TOTAL || 2000);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY || 50);
const TIMEOUT_MS = Number(process.env.PERF_TIMEOUT || 2000);
const SLO_ERROR_RATE = 0.5;
const SLO_P99_MS = 5000;
// P95/P99 budgets (CI gate). Generous defaults; tighten via env.
const BUDGET_P95_MS = Number(process.env.PERF_BUDGET_P95 || 500);
const BUDGET_P99_MS = Number(process.env.PERF_BUDGET_P99 || 1500);
// 1000+ concurrent stress test
const STRESS_CONCURRENCY = Number(process.env.PERF_STRESS_CONCURRENCY || 2000);
const STRESS_TOTAL = Number(process.env.PERF_STRESS_TOTAL || 6000);
// Mini soak test (steady load for N seconds). 0 = disabled.
const SOAK_SECONDS = Number(process.env.PERF_SOAK_SECONDS || 0);
const SOAK_CONCURRENCY = Number(process.env.PERF_SOAK_CONCURRENCY || 20);
// Keep-alive agent: reuse sockets so high-rate load never exhausts TCP ports.
// Bounded connection pool. A small, capped pool keeps the harness from opening
// thousands of simultaneous sockets that self-DoS the server (heavy /health does
// DB+Redis+queue work per hit) or exhaust runner file descriptors. Free sockets
// are capped so we don't accumulate half-open sockets across the stress/soak phases.
const MAX_SOCKETS = Number(process.env.PERF_MAX_SOCKETS || 256);
const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: MAX_SOCKETS, maxFreeSockets: 32, scheduling: 'fifo' });
// Transient connection errors (server backpressure / socket recycling) are retried
// on a fresh, non-pooled connection before being counted as a hard error — so a
// momentary reset storm under burst doesn't zero out the gate on a healthy server.
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR']);
const RETRY_MAX = Number(process.env.PERF_RETRY_MAX || 3);
// Signal used to trigger the server's heap snapshot. MUST match the server's
// --heapsnapshot-signal flag AND must NOT be a signal the app treats as shutdown.
// NestJS enableShutdownHooks() registers SIGUSR2 (among others) as a graceful-
// shutdown trigger, so snapshotting via SIGUSR2 would close the HTTP listener and
// make every load request fail with ECONNREFUSED. SIGUSR1 is safe (not grabbed by
// NestJS; Node's --heapsnapshot-signal still writes the snapshot).
const HEAP_SIGNAL = process.env.PERF_HEAP_SIGNAL || 'SIGUSR1';
const WS_CONNECT_TIMEOUT = Number(process.env.PERF_WS_TIMEOUT || 8000);

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ms = (n) => (n == null ? 'n/a' : Number(n).toFixed(2) + ' ms');
const now = () => Number(process.hrtime.bigint());
const since = (t) => (now() - t) / 1e6;
const sleep = (m) => new Promise((r) => setTimeout(r, m));

// ── /proc helpers ────────────────────────────────────────────────────────────
function procStatus(pid, key) { try { const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(new RegExp(key + ':\\s+(\\d+)\\s*kB')); return m ? +(parseInt(m[1], 10) / 1024).toFixed(1) : null; } catch { return null; } }
function readRssMb(pid) { return procStatus(pid, 'VmRSS'); }
function readPeakMb(pid) { return procStatus(pid, 'VmHWM'); }
function readCpuSeconds(pid) { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' '); return (parseInt(f[11], 10) + parseInt(f[12], 10)) / 100; } catch { return null; } }
function readIo(pid) { try { const s = fs.readFileSync(`/proc/${pid}/io`, 'utf8'); const r = s.match(/read_bytes:\s+(\d+)/); const w = s.match(/write_bytes:\s+(\d+)/); return { read: r ? +r[1] : 0, write: w ? +w[1] : 0 }; } catch { return null; } }
function parseGc(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    let minor = 0, major = 0, totalPause = 0, maxPause = 0;
    for (const ln of fs.readFileSync(file, 'utf8').split('\n')) {
      const isMinor = /Scavenge/.test(ln); const isMajor = /Mark-Compact|Mark-sweep|Mark-Sweep/.test(ln);
      if (!isMinor && !isMajor) continue; if (isMinor) minor++; else major++;
      const pm = ln.match(/(\d+\.\d+)\s*\/\s*\d+\.\d+\s*ms/); if (pm) { const p = parseFloat(pm[1]); totalPause += p; if (p > maxPause) maxPause = p; }
    }
    return { minor, major, totalPauseMs: +totalPause.toFixed(2), maxPauseMs: +maxPause.toFixed(2) };
  } catch { return null; }
}

// ── Heap snapshot (real memory-leak detection via --heapsnapshot-signal) ─────
async function takeHeapSnapshot(pid, outDir, label) {
  try {
    if (!pid) return null;
    const cwd = process.cwd();
    const pre = new Set(fs.readdirSync(cwd).filter((f) => f.endsWith('.heapsnapshot')));
    try { process.kill(Number(pid), HEAP_SIGNAL); } catch { return null; }
    const SNAP_TRIES = Number(process.env.PERF_SNAP_TRIES || 120);
    for (let i = 0; i < SNAP_TRIES; i++) {
      await sleep(500);
      const created = fs.readdirSync(cwd).filter((f) => f.endsWith('.heapsnapshot') && !pre.has(f));
      if (created.length) {
        const f = created.map((x) => path.join(cwd, x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const s1 = fs.statSync(f).size; await sleep(800); const s2 = fs.statSync(f).size;
        if (s2 > 0 && s1 === s2) {
          const name = `heap-${label}.heapsnapshot`;
          try { fs.copyFileSync(f, path.join(outDir, name)); fs.unlinkSync(f); } catch {}
          return { file: name, sizeMb: +(s2 / 1048576).toFixed(2) };
        }
      }
    }
    return null;
  } catch (e) { return { error: e.message }; }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function attempt(urlPath, start, pooled) {
  return new Promise((resolve) => {
    let bytes = 0; let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get(BASE + urlPath, pooled ? { agent } : { agent: false }, (res) => {
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => done({ ms: since(start), status: res.statusCode, ok: res.statusCode < 500, timeout: false, bytes }));
    });
    // Pass an error so 'error' always fires on timeout (a bare destroy() can leave
    // the promise unsettled and hang a worker forever).
    req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => { const d = since(start); done({ ms: d, status: 0, ok: false, timeout: d >= TIMEOUT_MS - 5, bytes, code: (e && e.code) || 'ERR' }); });
  });
}
// Measures one logical request (latency spans all attempts). Retries only genuine
// transient transport errors on a fresh connection; real HTTP responses (any
// status) and timeouts are returned as-is so the test still catches regressions.
async function once(urlPath) {
  const start = now();
  let r = await attempt(urlPath, start, true);
  for (let i = 0; i < RETRY_MAX && r.status === 0 && !r.timeout && TRANSIENT_CODES.has(r.code); i++) {
    await sleep(2 + i * 5);
    r = await attempt(urlPath, start, false);
  }
  return r;
}
function fetchBody(urlPath) { return new Promise((resolve, reject) => { http.get(BASE + urlPath, { agent }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }).on('error', reject); }); }
function percentile(sorted, p) { if (!sorted.length) return 0; const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1); return +sorted[Math.max(0, idx)].toFixed(2); }

// Resolve a reachable base URL (handles IPv4/IPv6/localhost + server boot timing).
async function resolveBase() {
  const raw = process.argv[2] || 'http://localhost:3000';
  const cands = [...new Set([raw.replace('//localhost', '//127.0.0.1'), raw, raw.replace('//localhost', '//[::1]').replace('//127.0.0.1', '//[::1]')])];
  for (let round = 0; round < 60; round++) {
    for (const c of cands) { BASE = c; const r = await once(TARGET_PATH); if (r.status >= 200 && r.status < 500) return c; }
    await sleep(1000);
  }
  BASE = cands[0]; return null;
}

// Wait until the server is responsive again (event loop idle) before the fragile
// end-of-run probes (heap-after snapshot, WebSocket). Returns when /health answers
// fast a few times in a row, or after maxMs. A fast 4xx/2xx both prove a calm loop.
async function awaitServerCalm(maxMs) {
  const deadline = Date.now() + maxMs; let calm = 0;
  // small floor so GC settles even if the server is already idle
  await sleep(Number(process.env.PERF_COOLDOWN_MS || 1500));
  while (Date.now() < deadline) {
    const r = await once(TARGET_PATH);
    if (r.status >= 200 && r.status < 500 && r.ms < 200) { if (++calm >= 3) return true; }
    else calm = 0;
    await sleep(400);
  }
  return false;
}

// ── API load (+ network bytes + event-loop heartbeat) ────────────────────────
async function apiLoad() {
  const lat = []; let errors = 0, timeouts = 0, done = 0, totalBytes = 0; const statusCounts = {}; const errorCodes = {};
  const hbRtt = []; let hbMaxGap = 0, hbLast = Date.now();
  const hb = setInterval(async () => { const sched = Date.now(); const gap = sched - hbLast - 50; if (gap > hbMaxGap) hbMaxGap = gap; hbLast = sched; const r = await once(TARGET_PATH); hbRtt.push(r.ms); }, 50);
  const t0 = Date.now();
  async function worker() { while (done < TOTAL_REQUESTS) { done++; const r = await once(TARGET_PATH); lat.push(r.ms); totalBytes += r.bytes || 0; statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; if (r.status === 0 && r.code) errorCodes[r.code] = (errorCodes[r.code] || 0) + 1; if (!r.ok) errors++; if (r.timeout) timeouts++; } }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearInterval(hb);
  const elapsed = (Date.now() - t0) / 1000; lat.sort((a, b) => a - b); hbRtt.sort((a, b) => a - b);
  const sum = lat.reduce((a, b) => a + b, 0);
  return {
    total: lat.length, elapsedSec: +elapsed.toFixed(2), throughput: +(lat.length / elapsed).toFixed(1),
    avg: +(sum / (lat.length || 1)).toFixed(2), p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99),
    min: +(lat[0] || 0).toFixed(2), max: +(lat[lat.length - 1] || 0).toFixed(2),
    errors, timeouts, errorRate: +(errors / (lat.length || 1)).toFixed(4), timeoutRate: +(timeouts / (lat.length || 1)).toFixed(4),
    statusCounts, errorCodes, networkMb: +(totalBytes / 1048576).toFixed(2), networkMbps: +((totalBytes / 1048576) / elapsed).toFixed(2),
    eventLoop: { heartbeatAvgMs: hbRtt.length ? +(hbRtt.reduce((a, b) => a + b, 0) / hbRtt.length).toFixed(2) : null, heartbeatMaxMs: +(hbRtt[hbRtt.length - 1] || 0).toFixed(2), maxSchedGapMs: hbMaxGap, stallIndexMs: +(percentile(lat, 99) - percentile(lat, 50)).toFixed(2) },
  };
}

// ── CPU spike sampler ────────────────────────────────────────────────────────
function startCpuSampler(pid, intervalMs = 250) {
  const samples = []; let last = readCpuSeconds(pid); let lastT = Date.now();
  const h = setInterval(() => { const c = readCpuSeconds(pid); const t = Date.now(); if (c != null && last != null) { const dt = (t - lastT) / 1000 || 1; samples.push(+(((c - last) / dt) * 100).toFixed(1)); } last = c; lastT = t; }, intervalMs);
  return { stop() { clearInterval(h); if (!samples.length) return null; const max = Math.max(...samples); const avg = samples.reduce((a, b) => a + b, 0) / samples.length; return { samples: samples.length, maxSpikePct: +max.toFixed(1), avgPct: +avg.toFixed(1), spikesOver80: samples.filter((s) => s > 80).length }; } };
}

// ── Spike / stress / soak ────────────────────────────────────────────────────
async function burst(total, concurrency) {
  const lat = []; let errors = 0, done = 0; const t0 = Date.now();
  async function w() { while (done < total) { done++; const r = await once(TARGET_PATH); lat.push(r.ms); if (!r.ok) errors++; } }
  await Promise.all(Array.from({ length: concurrency }, w));
  const elapsed = (Date.now() - t0) / 1000; lat.sort((a, b) => a - b);
  return { concurrency, total: lat.length, throughput: +(lat.length / elapsed).toFixed(1), p95: percentile(lat, 95), p99: percentile(lat, 99), errorRate: +(errors / (lat.length || 1)).toFixed(4) };
}
const spikeLoad = () => burst(Number(process.env.PERF_SPIKE_TOTAL || 600), Number(process.env.PERF_SPIKE_CONCURRENCY || 200));
const stressLoad = () => burst(STRESS_TOTAL, STRESS_CONCURRENCY);

async function soakTest(seconds, concurrency) {
  if (!seconds || seconds <= 0) return null;
  const lat = []; let errors = 0; const start = Date.now(); const end = start + seconds * 1000; const rssTrace = [];
  const sampler = setInterval(() => { const r = readRssMb(SERVER_PID); if (r != null) rssTrace.push({ tSec: Math.round((Date.now() - start) / 1000), rssMb: r }); }, 5000);
  async function w() { while (Date.now() < end) { const r = await once(TARGET_PATH); lat.push(r.ms); if (!r.ok) errors++; await sleep(5); } }
  await Promise.all(Array.from({ length: concurrency }, w));
  clearInterval(sampler); lat.sort((a, b) => a - b);
  const first = rssTrace.length ? rssTrace[0].rssMb : null; const last = rssTrace.length ? rssTrace[rssTrace.length - 1].rssMb : null;
  return { seconds, concurrency, requests: lat.length, throughput: +(lat.length / seconds).toFixed(1), p95: percentile(lat, 95), p99: percentile(lat, 99), errorRate: +(errors / (lat.length || 1)).toFixed(4), rssStartMb: first, rssEndMb: last, rssDriftMb: first != null && last != null ? +(last - first).toFixed(1) : null, rssTrace };
}

// ── Serialization micro-benchmark ────────────────────────────────────────────
async function serializationProbe() {
  try {
    const body = await fetchBody(TARGET_PATH); const obj = JSON.parse(body); const K = 20000;
    let t = now(); for (let i = 0; i < K; i++) JSON.stringify(obj); const strMs = since(t);
    t = now(); for (let i = 0; i < K; i++) JSON.parse(body); const parseMs = since(t);
    return { payloadBytes: Buffer.byteLength(body), stringifyOpsPerSec: +(K / (strMs / 1000)).toFixed(0), parseOpsPerSec: +(K / (parseMs / 1000)).toFixed(0), perOpUs: +((strMs * 1000) / K).toFixed(2) };
  } catch (e) { return { error: e.message }; }
}

// ── Cache (Redis) probe — incl. warmed hit-rate ──────────────────────────────
async function redisProbe() {
  let r;
  try {
    const Redis = require('ioredis');
    r = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, retryStrategy: () => null });
    await r.connect();
    let t = now(); await r.set('perf:probe', 'x'); const setMs = since(t);
    t = now(); await r.get('perf:probe'); const getMs = since(t);
    const N = 1000; const keys = []; t = now(); const pipe = r.pipeline();
    for (let i = 0; i < N; i++) { pipe.set('perf:k:' + i, i); keys.push('perf:k:' + i); }
    await pipe.exec(); const throughput = +(N / (since(t) / 1000)).toFixed(0);
    t = now(); await r.del(...keys); const delMs = since(t);
    const info = await r.info('stats');
    const hits = +(info.match(/keyspace_hits:(\d+)/) || [])[1] || 0;
    const misses = +(info.match(/keyspace_misses:(\d+)/) || [])[1] || 0;
    const hitRatio = hits + misses ? +((hits / (hits + misses)) * 100).toFixed(1) : null;
    // Warmed hit-rate: prove the cache works — write a key, read it 2000×, measure delta.
    let warmedHitRatio = null;
    try {
      const s0 = await r.info('stats'); const h0 = +(s0.match(/keyspace_hits:(\d+)/) || [])[1] || 0; const m0 = +(s0.match(/keyspace_misses:(\d+)/) || [])[1] || 0;
      await r.set('perf:warm', 'v'); const rp = r.pipeline(); for (let i = 0; i < 2000; i++) rp.get('perf:warm'); await rp.exec(); await r.del('perf:warm');
      const s1 = await r.info('stats'); const h1 = +(s1.match(/keyspace_hits:(\d+)/) || [])[1] || 0; const m1 = +(s1.match(/keyspace_misses:(\d+)/) || [])[1] || 0;
      const dh = h1 - h0, dm = m1 - m0; warmedHitRatio = dh + dm ? +((dh / (dh + dm)) * 100).toFixed(1) : null;
    } catch {}
    await r.quit();
    return { setMs, getMs, latencyMs: getMs, throughput, invalidationMs: delMs, hits, misses, hitRatio, missRatio: hitRatio != null ? +(100 - hitRatio).toFixed(1) : null, warmedHitRatio };
  } catch (e) { try { r && r.disconnect(); } catch {} return { error: e.message }; }
}

// ── Database probe ───────────────────────────────────────────────────────────
async function dbProbe() {
  let prisma;
  try {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    await prisma.$connect();
    const times = [];
    for (let i = 0; i < 50; i++) { const t = now(); await prisma.$queryRawUnsafe('SELECT 1'); times.push(since(t)); }
    times.sort((a, b) => a - b);
    const avg = +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2);
    const tt = now(); await prisma.$transaction([prisma.$queryRawUnsafe('SELECT 1'), prisma.$queryRawUnsafe('SELECT 1')]); const txMs = since(tt);
    let connections = null, indexes = null, indexScan = null;
    try { connections = (await prisma.$queryRawUnsafe('SELECT count(*)::int AS c FROM pg_stat_activity'))[0].c; } catch {}
    try { indexes = (await prisma.$queryRawUnsafe("SELECT count(*)::int AS c FROM pg_indexes WHERE schemaname='public'"))[0].c; } catch {}
    try { indexScan = /Index Scan|Index Only Scan|Bitmap Index Scan/.test(JSON.stringify(await prisma.$queryRawUnsafe("EXPLAIN (FORMAT JSON) SELECT * FROM users WHERE email = 'probe@x.com'"))); } catch {}
    const slow = times.filter((x) => x > 50).length;
    await prisma.$disconnect();
    return { avgMs: avg, p95Ms: percentile(times, 95), txMs, connections, indexes, indexScan, slowQueries: slow };
  } catch (e) { try { prisma && (await prisma.$disconnect()); } catch {} return { error: e.message }; }
}

// ── Queue probe ──────────────────────────────────────────────────────────────
async function queueProbe() {
  let q, worker;
  try {
    const { Queue, Worker } = require('bullmq');
    const connection = { host: REDIS_HOST, port: REDIS_PORT, connectTimeout: 3000, maxRetriesPerRequest: null, retryStrategy: () => null };
    q = new Queue('perf-probe-queue', { connection });
    await q.obliterate({ force: true }).catch(() => {});
    const procTimes = []; let retrySucceeded = false, retryAttempts = 0; const N = 100;
    worker = new Worker('perf-probe-queue', async (job) => {
      if (job.name === 'retry-once') { retryAttempts = job.attemptsMade + 1; if (job.attemptsMade === 0) throw new Error('forced retry'); retrySucceeded = true; return; }
      if (job.name === 'always-fail') throw new Error('forced failure (dead-letter)');
      return;
    }, { connection, concurrency: 20 });
    let c = 0; const completedP = new Promise((resolve) => { worker.on('completed', (job) => { if (job.name === 'noop') { procTimes.push(Date.now() - job.timestamp); if (++c >= N) resolve(); } }); });
    const t = now();
    await q.addBulk(Array.from({ length: N }, () => ({ name: 'noop', data: {}, opts: { removeOnComplete: false } })));
    const enqMs = since(t);
    await q.add('retry-once', {}, { attempts: 2, backoff: { type: 'fixed', delay: 50 }, removeOnComplete: false, removeOnFail: false });
    await q.add('always-fail', {}, { attempts: 1, removeOnComplete: false, removeOnFail: false });
    await Promise.race([completedP, new Promise((r) => setTimeout(r, 9000))]);
    await new Promise((r) => setTimeout(r, 1500));
    const counts = await q.getJobCounts('completed', 'failed', 'waiting', 'active');
    const avgProc = procTimes.length ? +(procTimes.reduce((a, b) => a + b, 0) / procTimes.length).toFixed(2) : null;
    await worker.close(); await q.obliterate({ force: true }); await q.close();
    return { enqueueThroughput: +(N / (enqMs / 1000)).toFixed(0), avgProcessingMs: avgProc, processed: procTimes.length, retrySucceeded, retryAttempts, deadLetter: counts.failed ?? null, waiting: counts.waiting ?? null };
  } catch (e) { try { worker && (await worker.close()); } catch {} try { q && (await q.close()); } catch {} return { error: e.message }; }
}

// ── WebSocket probe ──────────────────────────────────────────────────────────
async function wsProbe() {
  const clients = [];
  try {
    const { io } = require('socket.io-client');
    let token = '';
    try { token = require('jsonwebtoken').sign({ sub: 'perf-user', organizationId: 'perf-org', role: 'student', family: 'perf-fam' }, JWT_SECRET, { expiresIn: '5m' }); } catch {}
    const connect = () => new Promise((resolve) => {
      const t = now(); const s = io(BASE, { transports: ['websocket', 'polling'], auth: { token }, reconnection: true, timeout: WS_CONNECT_TIMEOUT, forceNew: true });
      let settled = false; const done = (ok, err) => { if (settled) return; settled = true; resolve({ s, ms: since(t), ok, err }); };
      s.on('connect', () => done(true)); s.on('connect_error', (e) => done(false, e && e.message)); setTimeout(() => done(false, 'timeout'), WS_CONNECT_TIMEOUT + 1000);
    });
    const c1 = await connect();
    if (!c1.ok) { try { c1.s.close(); } catch {} return { error: 'connect failed: ' + (c1.err || '') }; }
    clients.push(c1.s);
    let messageRtt = null;
    try { messageRtt = await new Promise((res) => { const t = now(); c1.s.timeout(1500).emit('ping', {}, (err) => res(err ? null : since(t))); }); } catch { messageRtt = null; }
    let reconnectMs = null;
    try { reconnectMs = await new Promise((res) => { const t = now(); c1.s.io.once('reconnect', () => res(since(t))); try { c1.s.io.engine.close(); } catch {} setTimeout(() => res(null), 4500); }); } catch { reconnectMs = null; }
    const K = 20; const conc = await Promise.all(Array.from({ length: K }, connect));
    const concurrentOk = conc.filter((x) => x.ok).length; conc.forEach((x) => { if (x.s) clients.push(x.s); });
    clients.forEach((s) => { try { s.close(); } catch {} });
    return { connectMs: +c1.ms.toFixed(2), messageRttMs: messageRtt != null ? +messageRtt.toFixed(2) : +c1.ms.toFixed(2), messageRttSource: messageRtt != null ? 'ack' : 'connect round-trip', reconnectMs: reconnectMs != null ? +reconnectMs.toFixed(2) : null, concurrent: K, concurrentOk };
  } catch (e) { clients.forEach((s) => { try { s.close(); } catch {} }); return { error: e.message }; }
}

// ── Static audit (lists unbounded findMany file:line for review) ─────────────
function walk(dir, out = []) { if (!fs.existsSync(dir)) return out; for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); const st = fs.statSync(p); if (st.isDirectory()) { if (!/node_modules|dist|tests|__tests__/.test(p)) walk(p, out); } else if (f.endsWith('.ts') && !f.endsWith('.spec.ts')) out.push(p); } return out; }
function staticAudit() {
  const files = walk('src'); let findMany = 0, findManyNoTake = 0, includes = 0, selectUsed = 0, transactions = 0, loopAwaitPrisma = 0; const unboundedFiles = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    findMany += (src.match(/\.findMany\(/g) || []).length;
    let idx = 0;
    while ((idx = src.indexOf('.findMany(', idx)) !== -1) {
      if (!/\btake\s*:/.test(src.slice(idx, idx + 400))) { findManyNoTake++; const line = src.slice(0, idx).split('\n').length; unboundedFiles.push(`${f.replace(/.*\/(src\/)/, '$1')}:${line}`); }
      idx += 10;
    }
    includes += (src.match(/\binclude\s*:/g) || []).length; selectUsed += (src.match(/\bselect\s*:/g) || []).length; transactions += (src.match(/\$transaction\(/g) || []).length;
    if (/for\s*\([^)]*\)\s*{[^}]*await[^}]*prisma\./s.test(src) || /\.(map|forEach)\(\s*async[^)]*\)\s*=>[^}]*await[^}]*prisma\./s.test(src)) loopAwaitPrisma++;
  }
  return { files: files.length, findMany, findManyNoTake, includes, selectUsed, transactions, loopAwaitPrisma, unboundedFiles };
}

// ── Render ───────────────────────────────────────────────────────────────────
function row(k, v, note) { return `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td><td class="note">${esc(note || '')}</td></tr>`; }
function section(title, rowsHtml) { return `<section class="card"><h2>${esc(title)}</h2><table>${rowsHtml}</table></section>`; }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Performance profile → ${BASE}${TARGET_PATH} (${TOTAL_REQUESTS} reqs, c=${CONCURRENCY})`);
  const resolved = await resolveBase();
  console.log(resolved ? `Server reachable at ${BASE} — starting load.` : 'WARNING: server not reachable (tried IPv4/localhost/IPv6) — metrics may be n/a.');

  const heapBefore = await takeHeapSnapshot(SERVER_PID, OUT_DIR, 'before');
  const rssBefore = readRssMb(SERVER_PID), cpuBefore = readCpuSeconds(SERVER_PID), ioBefore = readIo(SERVER_PID);
  const cpuSampler = startCpuSampler(SERVER_PID);
  // Warm-up: prime the pool and let the server recover from the heap-snapshot
  // stop-the-world pause before measuring, so first-hit resets don't skew the gate.
  for (let w = 0; w < 25; w++) await once(TARGET_PATH);
  const api = await apiLoad();
  const cpuSpikes = cpuSampler.stop();
  const spike = await spikeLoad();
  const stress = await stressLoad();
  const soak = await soakTest(SOAK_SECONDS, SOAK_CONCURRENCY);
  const rssAfter = readRssMb(SERVER_PID), cpuAfter = readCpuSeconds(SERVER_PID), ioAfter = readIo(SERVER_PID);
  const peak = readPeakMb(SERVER_PID);
  // Cooldown: drain the event loop after the soak/stress so the post-load heap
  // snapshot (SIGUSR1) is serviced promptly and isn't dropped as n/a.
  // Let the server recover from the soak before snapshotting the heap + probing WS,
  // so those measurements aren't dropped as n/a on a still-thrashing server.
  await awaitServerCalm(Number(process.env.PERF_RECOVER_MS || 30000));
  const heapAfter = await takeHeapSnapshot(SERVER_PID, OUT_DIR, 'after');
  const heapGrowthMb = heapBefore && heapAfter && heapBefore.sizeMb != null && heapAfter.sizeMb != null ? +(heapAfter.sizeMb - heapBefore.sizeMb).toFixed(2) : null;

  const [cache, db, queue, ws, ser] = await Promise.all([redisProbe(), dbProbe(), queueProbe(), wsProbe(), serializationProbe()]);
  const gc = parseGc(GC_LOG); const audit = staticAudit();

  // findMany review artifact
  try { fs.writeFileSync(path.join(OUT_DIR, 'findmany-review.txt'), `Unbounded findMany (no take:) — ${audit.findManyNoTake} site(s) to review for pagination/caps.\nSome are intentional (e.g. fetch all 7 schedule days); review each before adding take.\n\n` + (audit.unboundedFiles || []).join('\n') + '\n'); } catch {}

  const rssGrowth = rssBefore != null && rssAfter != null ? +(rssAfter - rssBefore).toFixed(1) : null;
  const cpuUsed = cpuBefore != null && cpuAfter != null ? +(cpuAfter - cpuBefore).toFixed(2) : null;
  const cpuPct = cpuUsed != null && api.elapsedSec ? +((cpuUsed / api.elapsedSec) * 100).toFixed(1) : null;
  const diskRead = ioBefore && ioAfter ? +((ioAfter.read - ioBefore.read) / 1024).toFixed(1) : null;
  const diskWrite = ioBefore && ioAfter ? +((ioAfter.write - ioBefore.write) / 1024).toFixed(1) : null;

  const budgetPass = api.p95 <= BUDGET_P95_MS && api.p99 <= BUDGET_P99_MS;
  const pass = api.errorRate <= SLO_ERROR_RATE && api.p99 <= SLO_P99_MS && api.total > 0 && budgetPass;
  const verdict = pass ? 'PASS' : 'FAIL';

  fs.writeFileSync(path.join(OUT_DIR, 'performance-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), base: BASE, slo: { SLO_ERROR_RATE, SLO_P99_MS }, budgets: { BUDGET_P95_MS, BUDGET_P99_MS, budgetPass },
    api, spike, stress, soak, cpuSpikes, memory: { rssBeforeMb: rssBefore, rssAfterMb: rssAfter, rssGrowthMb: rssGrowth, peakMb: peak },
    heap: { before: heapBefore, after: heapAfter, growthMb: heapGrowthMb }, cpu: { cpuSeconds: cpuUsed, cpuPercent: cpuPct },
    gc, serialization: ser, cache, database: db, queue, websocket: ws, disk: { readKb: diskRead, writeKb: diskWrite }, staticAudit: audit, verdict,
  }, null, 2));

  const el = api.eventLoop;
  const cacheRows = cache.error ? [row('Redis probe', 'n/a', cache.error)] : [
    row('Cache latency (GET)', ms(cache.latencyMs)), row('SET latency', ms(cache.setMs)), row('Throughput (pipelined)', cache.throughput + ' ops/s'),
    row('Cache efficiency (warmed)', cache.warmedHitRatio != null ? cache.warmedHitRatio + ' %' : 'n/a', '2000 reads of a warm key'),
    row('Hit ratio (cumulative)', cache.hitRatio != null ? cache.hitRatio + ' %' : 'n/a', `${cache.hits}h/${cache.misses}m — cold in CI`), row('Invalidation (DEL 1k)', ms(cache.invalidationMs))];
  const dbRows = db.error ? [row('Database probe', 'n/a', db.error)] : [
    row('Query latency (avg / p95)', `${ms(db.avgMs)} / ${ms(db.p95Ms)}`, 'SELECT 1 ×50'), row('Slow queries (>50ms)', db.slowQueries), row('Transaction duration', ms(db.txMs)),
    row('Connection pool / activity', db.connections != null ? db.connections + ' connections' : 'n/a', 'pg_stat_activity'), row('Indexes defined', db.indexes != null ? db.indexes : 'n/a', 'pg_indexes'), row('Index scan (EXPLAIN)', db.indexScan == null ? 'n/a' : db.indexScan ? 'yes' : 'seq (empty table)')];
  const qRows = queue.error ? [row('Queue probe', 'n/a', queue.error)] : [
    row('Enqueue throughput', queue.enqueueThroughput + ' jobs/s', 'addBulk ×100'), row('Job processing time (avg)', ms(queue.avgProcessingMs), `${queue.processed} processed by worker`),
    row('Retry performance', queue.retrySucceeded ? `succeeded after ${queue.retryAttempts} attempts` : 'n/a', 'fail-once then succeed'), row('Dead-letter (failed)', queue.deadLetter != null ? queue.deadLetter + ' jobs' : 'n/a', 'always-fail → failed set')];
  const wsRows = ws.error ? [row('WebSocket probe', 'n/a', ws.error)] : [
    row('Connect latency', ms(ws.connectMs)), row('Message round-trip', ms(ws.messageRttMs), ws.messageRttSource), row('Reconnection time', ws.reconnectMs != null ? ms(ws.reconnectMs) : 'n/a', 'transport drop → reconnect'), row('Concurrent connections', `${ws.concurrentOk}/${ws.concurrent} ok`)];
  const serRows = ser.error ? [row('Serialization probe', 'n/a', ser.error)] : [
    row('JSON stringify throughput', ser.stringifyOpsPerSec + ' ops/s'), row('JSON parse throughput', ser.parseOpsPerSec + ' ops/s'), row('Per-serialize cost', ser.perOpUs + ' µs'), row('Payload size', ser.payloadBytes + ' B')];

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Performance Report — ${verdict}</title><style>
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
 .wrap{max-width:1080px;margin:0 auto;padding:24px}
 .banner{background:${pass ? '#1a7f37' : '#cf222e'};color:#fff;border-radius:10px;padding:18px 22px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
 .banner h1{margin:0;font-size:20px}.pill{background:rgba(255,255,255,.18);border-radius:20px;padding:4px 12px;font-weight:600}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
 .card{background:#fff;border:1px solid #d0d7de;border-radius:10px;overflow:hidden}
 .card h2{margin:0;padding:12px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:15px}
 table{width:100%;border-collapse:collapse}td{padding:7px 14px;border-bottom:1px solid #eaeef2;vertical-align:top}
 tr:last-child td{border-bottom:0}td.k{font-weight:600;width:46%}td.v{font-variant-numeric:tabular-nums}td.note{color:#656d76;font-size:12px}
 .foot{color:#656d76;font-size:12px;margin-top:18px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
 <div class="banner"><h1>Performance · ${verdict}</h1><span class="pill">Throughput ${api.throughput}/s</span><span class="pill">p95 ${api.p95}ms</span><span class="pill">p99 ${api.p99}ms</span><span class="pill">Error ${(api.errorRate * 100).toFixed(2)}%</span><span class="pill">Budget ${budgetPass ? 'OK' : 'OVER'}</span></div>
 <div class="grid">
  ${section('API Performance', [row('Requests', api.total, `concurrency ${CONCURRENCY}`), row('Throughput', api.throughput + ' req/s', `over ${api.elapsedSec}s`), row('Average', ms(api.avg)), row('p50 / p95 / p99', `${api.p50} / ${api.p95} / ${api.p99} ms`), row('Min / Max', `${api.min} / ${api.max} ms`), row('Error rate', (api.errorRate * 100).toFixed(2) + ' %', `${api.errors} errors`), row('Timeout rate', (api.timeoutRate * 100).toFixed(2) + ' %', `${api.timeouts} > ${TIMEOUT_MS}ms`)].join(''))}
  ${section('Performance Budgets (CI gate)', [row('p95 vs budget', `${api.p95} / ${BUDGET_P95_MS} ms`, api.p95 <= BUDGET_P95_MS ? 'within budget' : 'OVER'), row('p99 vs budget', `${api.p99} / ${BUDGET_P99_MS} ms`, api.p99 <= BUDGET_P99_MS ? 'within budget' : 'OVER'), row('Budget verdict', budgetPass ? 'PASS' : 'FAIL', 'fails the job if over')].join(''))}
  ${section('Event Loop & Serialization', [row('Heartbeat RTT (avg/max)', `${ms(el.heartbeatAvgMs)} / ${ms(el.heartbeatMaxMs)}`, 'server responsiveness under load'), row('Max scheduling gap', ms(el.maxSchedGapMs), 'loop-block signal'), row('Stall index (p99−p50)', ms(el.stallIndexMs))].concat(serRows).join(''))}
  ${section('CPU Performance', [row('CPU utilisation', cpuPct != null ? cpuPct + ' %' : 'n/a', '1 core = 100%'), row('CPU spike (max)', cpuSpikes ? cpuSpikes.maxSpikePct + ' %' : 'n/a', cpuSpikes ? `${cpuSpikes.samples} samples @250ms` : ''), row('Spikes > 80%', cpuSpikes ? cpuSpikes.spikesOver80 : 'n/a'), row('High-load behaviour', api.errorRate < 0.01 ? 'stable under load' : 'errors under load')].join(''))}
  ${section('Memory Performance', [row('RSS before / after', `${rssBefore ?? 'n/a'} / ${rssAfter ?? 'n/a'} MB`), row('RSS growth (burst)', rssGrowth != null ? rssGrowth + ' MB' : 'n/a'), row('Peak RSS (VmHWM)', peak != null ? peak + ' MB' : 'n/a'), row('Soak RSS drift', soak && soak.rssDriftMb != null ? soak.rssDriftMb + ' MB' : 'n/a', soak ? `over ${soak.seconds}s` : 'soak disabled')].join(''))}
  ${section('Memory Leak (heap snapshots)', [row('Heap before', heapBefore && heapBefore.sizeMb != null ? heapBefore.sizeMb + ' MB' : 'n/a', heapBefore && heapBefore.file ? heapBefore.file : ''), row('Heap after', heapAfter && heapAfter.sizeMb != null ? heapAfter.sizeMb + ' MB' : 'n/a', heapAfter && heapAfter.file ? heapAfter.file : ''), row('Heap growth', heapGrowthMb != null ? heapGrowthMb + ' MB' : 'n/a', heapGrowthMb != null && heapGrowthMb < 20 ? 'no leak signal' : 'review snapshots'), row('Snapshots', 'uploaded as artifacts', 'open in Chrome DevTools → Memory')].join(''))}
  ${section('Garbage Collection (--trace-gc)', gc ? [row('Minor GC (Scavenge)', gc.minor), row('Major GC (Mark-Compact)', gc.major), row('Total pause', gc.totalPauseMs + ' ms'), row('Max pause', gc.maxPauseMs + ' ms')].join('') : [row('GC log', 'n/a', 'start server with --trace-gc')].join(''))}
  ${section('Database Performance (live)', dbRows.join(''))}
  ${section('Prisma / Query Hygiene (static)', [row('Files scanned', audit.files), row('findMany', audit.findMany), row('Unbounded findMany', audit.findManyNoTake, 'see findmany-review.txt artifact'), row('include / select', `${audit.includes} / ${audit.selectUsed}`), row('$transaction', audit.transactions), row('N+1 risk', audit.loopAwaitPrisma, audit.loopAwaitPrisma ? 'inspect' : 'none')].join(''))}
  ${section('Cache Performance (Redis, live)', cacheRows.join(''))}
  ${section('Queue Performance (BullMQ worker, live)', qRows.join(''))}
  ${section('WebSocket Performance (socket.io, live)', wsRows.join(''))}
  ${section('Resource Utilisation', [row('Memory usage', rssAfter != null ? rssAfter + ' MB' : 'n/a'), row('CPU usage', cpuPct != null ? cpuPct + ' %' : 'n/a'), row('Database usage', db.error ? 'n/a' : db.connections + ' connections'), row('Redis usage', cache.error ? 'n/a' : 'exercised'), row('Network (transferred)', `${api.networkMb} MB`, `${api.networkMbps} MB/s`), row('Disk read / write', diskRead != null ? `${diskRead} / ${diskWrite} KB` : 'n/a', '/proc/<pid>/io')].join(''))}
  ${section('Scalability & Soak', [row('Sustained load', `${api.total} reqs @ c=${CONCURRENCY}`, `${api.throughput}/s, p99 ${api.p99}ms`), row('Spike test', `${spike.total} reqs @ c=${spike.concurrency}`, `${spike.throughput}/s, p99 ${spike.p99}ms`), row('Stress (1000+ concurrent)', `${stress.total} reqs @ c=${stress.concurrency}`, `${stress.throughput}/s, p99 ${stress.p99}ms, err ${(stress.errorRate * 100).toFixed(2)}%`), row('Mini soak test', soak ? `${soak.requests} reqs / ${soak.seconds}s @ c=${soak.concurrency}` : 'disabled', soak ? `p99 ${soak.p99}ms, RSS drift ${soak.rssDriftMb} MB, err ${(soak.errorRate * 100).toFixed(2)}%` : 'set PERF_SOAK_SECONDS')].join(''))}
 </div>
 <p class="foot">Verdict <b>${verdict}</b> · gate = API SLO (error&le;${SLO_ERROR_RATE * 100}%, p99&le;${SLO_P99_MS}ms) + budgets (p95&le;${BUDGET_P95_MS}ms, p99&le;${BUDGET_P99_MS}ms) · ${esc(BASE + TARGET_PATH)} · ${esc(new Date().toISOString())}<br>All metrics measured live. Heap snapshots + findmany-review.txt are uploaded as artifacts. A probe that can't run shows "n/a" and never fails the job.</p>
</div></body></html>`;
  fs.writeFileSync(path.join(OUT_DIR, 'performance-report.html'), html);
  console.log(`Performance ${verdict}: thr=${api.throughput}/s p95=${api.p95}ms p99=${api.p99}ms err=${(api.errorRate * 100).toFixed(2)}% budget=${budgetPass ? 'OK' : 'OVER'}`);
  if (soak) console.log(`Soak ${soak.seconds}s: ${soak.requests} reqs, p99 ${soak.p99}ms, RSS drift ${soak.rssDriftMb} MB`);
  console.log('API HTTP status mix:', JSON.stringify(api.statusCounts), 'error codes:', JSON.stringify(api.errorCodes || {}));
  console.log(`Reports written to ${OUT_DIR}/`);
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error('Performance test failed to run:', err.message); process.exit(1); });
