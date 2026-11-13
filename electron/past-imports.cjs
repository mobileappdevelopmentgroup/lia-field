// Lia Office — past-imports.cjs
//
// Recovering the ladder records of imports that went into BSI but never
// reached the database (see office-records.cjs for why: from 2026-09-21 no
// import was recorded, and some before that were lost too).
//
// The only copy of what those imports contained is on the computer that ran
// them: every run writes `~/Documents/Lia Logs/run-<UTC time>.json`, listing
// each ladder's serial and whether its box went in. That is what this reads.
//
// What a run log does NOT carry, and how each gap is filled:
//   * the work order — the office types it, per run, before anything is sent;
//   * the inspection date — the run's own date, in local time (an import is
//     done the day the techs hand the sheet in, usually the day of the work);
//   * brand / type / length — not needed: record_inspection carries forward
//     what an earlier record of the same ladder had, and BSI already has them.
//
// Which ladders count: those whose box went in (success, partial). "skipped"
// means the box was already on the work order from an earlier run — that run
// has its own log — and "error" means it never went in.
//
// Pure Node, tested by electron/test/past-imports.test.mjs.

'use strict';

const fs = require('fs');
const path = require('path');
const officeRecords = require('./office-records.cjs');

const NAME = /^run-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.json$/;
const IMPORTED = new Set(['success', 'partial']);

function serialKey(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// The file name is the run's start in UTC (reporter.ts: toISOString()).
function runTime(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

// One run log → what it says, or null if it is not one.
function readRun(file) {
  const name = path.basename(file);
  const at = runTime(name);
  if (!at) return null;
  let j;
  const unreadable = { name, startedAt: at.toISOString(), unreadable: true };
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return unreadable; }
  const results = Array.isArray(j && j.ladderResults) ? j.ladderResults : null;
  if (!results) return unreadable;

  const counts = { success: 0, partial: 0, skipped: 0, error: 0 };
  const seen = new Set();
  const serials = [];
  for (const r of results) {
    const st = String(r && r.status || '');
    if (st in counts) counts[st]++;
    const serial = String(r && r.serialNum || '').trim();
    if (!IMPORTED.has(st) || !serial || seen.has(serialKey(serial))) continue;
    seen.add(serialKey(serial));
    serials.push(serial);
  }
  return {
    name,
    startedAt: at.toISOString(),
    date: officeRecords.localDate(at),
    total: results.length,
    counts,
    serials,          // went into BSI, once each
  };
}

// Every run log in `dir`, newest first. Missing folder → none.
function listRuns(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter(n => NAME.test(n))
    .map(n => readRun(path.join(dir, n)))
    .filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// `existing`: rows { serial_num, inspection_date } already in the database.
// Splits a run's ladders into those still to record and those already there
// (any record of that ladder on that date counts — a phone may have sent it).
function plan(run, existing) {
  const have = new Set((existing || []).map(e => serialKey(e.serial_num) + '|' + e.inspection_date));
  const todo = [], already = [];
  for (const s of run.serials || []) (have.has(serialKey(s) + '|' + run.date) ? already : todo).push(s);
  return { todo, already };
}

// The payloads for the ladders still to record.
function recordsFor(run, todo, workOrderId, techName) {
  return officeRecords.toRecords(todo.map(serial => ({ serial })), workOrderId, techName,
                                 'office:recovered', run.date);
}

// ── Which runs have been recovered, on this computer ────────────────────────
// Kept so a run is not offered twice. The database would not duplicate it —
// a second save of the same ladder and date supersedes — but the office should
// see what is done.
function readLedger(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (_) { return {}; }
}

function markRecovered(file, runName, info) {
  const led = readLedger(file);
  led[runName] = Object.assign({}, info);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(led, null, 2));
  fs.renameSync(file + '.tmp', file);
  return led;
}

module.exports = { runTime, readRun, listRuns, plan, recordsFor, readLedger, markRecovered, serialKey };
