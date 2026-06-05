#!/usr/bin/env node
/**
 * scripts/ci/jest-report.js  <jest-results.json>  <output.html>
 *
 * Converts a Jest `--json` results file into a human-readable HTML report:
 * a summary banner (total / passed / failed / skipped, pass rate, duration)
 * and a per-file breakdown listing every test scenario with a green tick or a
 * red cross, its duration, and any failure message. Zero dependencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const inFile = process.argv[2];
const outFile = process.argv[3];
if (!inFile || !outFile) {
  console.error('usage: node jest-report.js <results.json> <output.html>');
  process.exit(1);
}
if (!fs.existsSync(inFile)) {
  console.error('results file not found: ' + inFile);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const total = data.numTotalTests ?? 0;
const passed = data.numPassedTests ?? 0;
const failed = data.numFailedTests ?? 0;
const pending = data.numPendingTests ?? 0;
const suites = data.testResults || [];
const rate = total ? Math.round((passed / total) * 100) : 100;
const when = new Date(data.startTime || Date.now()).toISOString();
const overall = failed === 0 ? 'PASSED' : 'FAILED';
const badge = failed === 0 ? '#1a7f37' : '#cf222e';

function suiteRows(s) {
  const file = path.basename(s.name || s.testFilePath || 'unknown');
  const asserts = s.assertionResults || [];
  const rows = asserts.map((a) => {
    const ok = a.status === 'passed';
    const skip = a.status === 'pending' || a.status === 'skipped' || a.status === 'todo';
    const icon = ok ? '✅' : skip ? '⚪' : '❌';
    const ms = a.duration != null ? a.duration + ' ms' : '';
    const ctx = (a.ancestorTitles || []).join(' › ');
    const name = (ctx ? ctx + ' › ' : '') + (a.title || a.fullName || '');
    const fail = (a.failureMessages || []).join('\n\n');
    return (
      '<tr class="' + (ok ? 'p' : skip ? 's' : 'f') + '">' +
      '<td class="i">' + icon + '</td>' +
      '<td class="n">' + esc(name) +
        (fail ? '<pre class="err">' + esc(fail) + '</pre>' : '') + '</td>' +
      '<td class="d">' + esc(ms) + '</td></tr>'
    );
  }).join('');
  const sf = asserts.filter((a) => a.status === 'failed').length;
  return (
    '<section class="suite ' + (sf ? 'has-fail' : '') + '">' +
    '<h3>' + (sf ? '❌' : '✅') + ' ' + esc(file) +
      ' <span class="meta">' + asserts.length + ' tests</span></h3>' +
    '<table>' + rows + '</table></section>'
  );
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test Report — ${esc(overall)}</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}
  .wrap{max-width:1000px;margin:0 auto;padding:24px}
  .banner{background:${badge};color:#fff;border-radius:10px;padding:18px 22px;display:flex;flex-wrap:wrap;gap:18px;align-items:center}
  .banner h1{margin:0;font-size:20px}
  .pill{background:rgba(255,255,255,.18);border-radius:20px;padding:4px 12px;font-weight:600}
  .suite{background:#fff;border:1px solid #d0d7de;border-radius:10px;margin:16px 0;overflow:hidden}
  .suite.has-fail{border-color:#cf222e}
  .suite h3{margin:0;padding:12px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:15px}
  .meta{color:#656d76;font-weight:400;font-size:12px;margin-left:6px}
  table{width:100%;border-collapse:collapse}
  td{padding:8px 12px;border-bottom:1px solid #eaeef2;vertical-align:top}
  tr:last-child td{border-bottom:0}
  td.i{width:28px;text-align:center}
  td.d{width:90px;color:#656d76;text-align:right;white-space:nowrap}
  tr.f td.n{color:#cf222e;font-weight:600}
  tr.s td.n{color:#9a6700}
  pre.err{background:#fff0f0;border:1px solid #ffc9c9;border-radius:6px;padding:10px;margin:8px 0 0;white-space:pre-wrap;font-size:12px;color:#86181d}
  .foot{color:#656d76;font-size:12px;margin-top:20px}
</style></head>
<body><div class="wrap">
  <div class="banner">
    <h1>${esc(overall)}</h1>
    <span class="pill">Total ${total}</span>
    <span class="pill">✅ Passed ${passed}</span>
    <span class="pill">❌ Failed ${failed}</span>
    <span class="pill">⚪ Skipped ${pending}</span>
    <span class="pill">Pass rate ${rate}%</span>
  </div>
  ${suites.map(suiteRows).join('')}
  <p class="foot">Generated from ${esc(path.basename(inFile))} · run started ${esc(when)}</p>
</div></body></html>`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, 'utf8');
console.log(`Report written: ${outFile} (${overall} — ${passed}/${total} passed)`);
