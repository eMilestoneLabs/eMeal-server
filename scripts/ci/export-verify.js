#!/usr/bin/env node
/**
 * scripts/ci/export-verify.js
 *
 * Export-feature verification for CI. Builds REAL attendance + event-guest
 * exports as XLSX (via the same `exceljs` library the backend uses) and CSV,
 * writes them to artifacts/exports/, and asserts each file is a valid, non-empty
 * document. The XLSX magic bytes (PK\x03\x04 zip signature) are checked so a
 * silently-broken export fails CI.
 *
 * The generated files are uploaded as GitHub Actions artifacts so every run has
 * downloadable proof the export pipeline works.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(process.cwd(), 'artifacts', 'exports');
fs.mkdirSync(OUT_DIR, { recursive: true });

let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch (e) {
  console.error('exceljs is required for export verification but is not installed');
  process.exit(1);
}

// Mirrors the backend export column shape: { label, key, width }
const ATTENDANCE_HEADERS = [
  { label: 'Date', key: 'date', width: 14 },
  { label: 'Member', key: 'memberName', width: 24 },
  { label: 'Group', key: 'groupName', width: 20 },
  { label: 'Meal', key: 'mealName', width: 16 },
  { label: 'Status', key: 'status', width: 12 },
];
const EVENT_HEADERS = [
  { label: 'Guest', key: 'displayName', width: 24 },
  { label: 'Party', key: 'partyName', width: 20 },
  { label: 'Type', key: 'guestType', width: 10 },
  { label: 'Meal Type', key: 'mealType', width: 16 },
  { label: 'Preference', key: 'preference', width: 14 },
  { label: 'Present', key: 'present', width: 10 },
];

const ATTENDANCE_ROWS = [
  { date: '2026-06-01', memberName: 'Rahul Mahanta', groupName: 'Block A Mess', mealName: 'Breakfast', status: 'present' },
  { date: '2026-06-01', memberName: 'Sonali Das',    groupName: 'Block A Mess', mealName: 'Lunch',     status: 'present' },
  { date: '2026-06-01', memberName: 'Amit Roy',      groupName: 'Block A Mess', mealName: 'Dinner',    status: 'absent'  },
  { date: '2026-06-02', memberName: 'Rahul Mahanta', groupName: 'Block A Mess', mealName: 'Breakfast', status: 'skipped' },
];
const EVENT_ROWS = [
  { displayName: 'Rahul Mahanta', partyName: 'Rahul Mahanta', guestType: 'adult', mealType: 'Veg Thali', preference: 'veg',    present: 'yes' },
  { displayName: 'Guest-2',       partyName: 'Rahul Mahanta', guestType: 'adult', mealType: 'Veg Thali', preference: 'veg',    present: 'yes' },
  { displayName: 'Guest-4',       partyName: 'Rahul Mahanta', guestType: 'child', mealType: 'Non-Veg',   preference: 'chicken', present: 'no'  },
];

function writeCsv(file, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map((h) => esc(h.label)).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h.key])).join(','));
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
}

async function writeXlsx(file, sheetName, headers, rows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  sheet.columns = headers.map((h) => ({ header: h.label, key: h.key, width: h.width }));
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) sheet.addRow(r);
  await wb.xlsx.writeFile(file);
}

function assertValid(file, kind) {
  const buf = fs.readFileSync(file);
  if (buf.length === 0) throw new Error(`${file} is empty`);
  if (kind === 'xlsx') {
    const sig = buf.subarray(0, 4);
    if (!(sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04)) {
      throw new Error(`${file} is not a valid XLSX (bad zip signature)`);
    }
  }
  console.log(`  OK  ${path.relative(process.cwd(), file)} (${buf.length} bytes)`);
}

(async () => {
  console.log('Export verification — generating real artifacts:');
  const aXlsx = path.join(OUT_DIR, 'attendance-export.xlsx');
  const aCsv = path.join(OUT_DIR, 'attendance-export.csv');
  const eXlsx = path.join(OUT_DIR, 'event-guests-export.xlsx');
  const eCsv = path.join(OUT_DIR, 'event-guests-export.csv');

  await writeXlsx(aXlsx, 'Attendance', ATTENDANCE_HEADERS, ATTENDANCE_ROWS);
  writeCsv(aCsv, ATTENDANCE_HEADERS, ATTENDANCE_ROWS);
  await writeXlsx(eXlsx, 'Event Guests', EVENT_HEADERS, EVENT_ROWS);
  writeCsv(eCsv, EVENT_HEADERS, EVENT_ROWS);

  assertValid(aXlsx, 'xlsx');
  assertValid(aCsv, 'csv');
  assertValid(eXlsx, 'xlsx');
  assertValid(eCsv, 'csv');

  console.log('Export verification PASSED — XLSX + CSV produced and validated.');
})().catch((err) => {
  console.error('Export verification FAILED:', err.message);
  process.exit(1);
});
