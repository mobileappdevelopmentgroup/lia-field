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
// What a run log from before 1.15.10 does NOT carry, and how each gap is filled
// (from 1.15.10 the log carries the work order and account in `lia`):
//   * the work order — the office types it on the Recover screen, or the
//     automatic check records it blank (decided 2026-11-13) for Field Work to
//     fill in later;
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
    meta: readMeta(j.lia),
  };
}

// What Lia Office 1.15.10+ wrote about the import, or null for an older log.
function readMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const accountId = str(m.accountId);
  if (!accountId) return null;      // without the account it cannot be placed
  return { workOrderId: (str(m.workOrderId) || '').slice(0, 64), accountId,
           accountName: str(m.accountName), techName: str(m.techName) };
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

// `existing`: rows { serial_num, inspection_date } already in the database,
// deleted ones included. Splits a run's ladders into those still to record
// and those already there. A record of that ladder within a day of the run
// counts: a phone may have sent it, an older Lia Office dated it in UTC, and
// one somebody DELETED must stay deleted — test imports were removed by hand.
function shiftDate(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function plan(run, existing) {
  const have = new Set((existing || []).map(e => serialKey(e.serial_num) + '|' + e.inspection_date));
  const days = [shiftDate(run.date, -1), run.date, shiftDate(run.date, 1)];
  const todo = [], already = [];
  for (const s of run.serials || []) {
    const k = serialKey(s);
    (days.some(d => have.has(k + '|' + d)) ? already : todo).push(s);
  }
  return { todo, already };
}

// ── The automatic check ──────────────────────────────────────────────────────
// Records were lost from here on (11 of Nate's work orders from 2026-08-25,
// every import from 2026-09-21). An older log without a work order is left to
// the Recover screen: records were being saved then, and a gap that old is as
// likely to be a test import as a lost one.
const AUTO_FROM = '2026-08-25';

// May the check record this run, signed in as `ctx` (my_context)? It writes
// into whatever account is being acted as, so a run is recorded only where it
// belongs:
//   * a log that names its account — only while that account is the one in
//     use (Batavia acting as Nate picks up Batavia's imports for Nate);
//   * an older log — into the account in use, unless that is an umbrella:
//     an umbrella's imports were mostly for a subcontractor, and which one is
//     not in the log. Those wait for the Recover screen.
// → { go: true, workOrderId } or { go: false, why }
function decide(run, ctx) {
  if (!run || run.unreadable) return { go: false, why: 'unreadable' };
  if (!ctx || !ctx.account_id) return { go: false, why: 'no-account' };
  if (run.meta) {
    return run.meta.accountId === ctx.account_id
      ? { go: true, workOrderId: run.meta.workOrderId }
      : { go: false, why: 'other-account' };
  }
  if (run.date < AUTO_FROM) return { go: false, why: 'before-window' };
  if (ctx.acting_is_umbrella) return { go: false, why: 'umbrella' };
  return { go: true, workOrderId: '' };
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

module.exports = { runTime, readRun, listRuns, plan, decide, AUTO_FROM, recordsFor, readLedger, markRecovered, serialKey };
