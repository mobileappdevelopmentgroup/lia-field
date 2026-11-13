// Lia Office — office-records.cjs
//
// Saving the ladders of a finished BSI import as inspection records.
//
// ── Why this is its own file ───────────────────────────────────────────────
// From 2026-08-22 until this file existed, not one ladder imported through Lia
// Office reached the database: eleven of Nate's work orders were imported and
// charged (2026-08-25 → 2026-10-11) with no records behind them. The old code
// called record_inspections and threw the result away — `.catch(() => {})` and
// an `errors` array nobody read — so whatever was refusing them was never
// seen. Everything here is built so that cannot happen quietly again:
//
//   * The outcome is RETURNED, and main shows it in the run log.
//   * A batch the server refuses is retried one ladder at a time, so one bad
//     row costs one record, not the hundred it shared a round trip with.
//   * Whatever still fails is kept on disk (the outbox) and retried later.
//     The inspection date is fixed when the ladder is imported, so a retry
//     next week does not re-date it.
//   * An outbox entry carries the account it was recorded under. While the
//     office is acting as a subcontractor, every write lands in THEIR account;
//     a retry after that session ended would land in the office's own. So an
//     entry is only retried while the office is in that same account again.
//
// Pure Node; `sb` is anything with supabase-js's rpc(). Tested by
// electron/test/office-records.test.mjs without Electron.

'use strict';

const fs = require('fs');
const path = require('path');

const BATCH = 100;

// Today in local time as YYYY-MM-DD. The server's default is its own
// current_date, which is UTC: an import finished at 8pm in Pennsylvania would
// be dated tomorrow.
function localDate(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// CSV rows ({ serial, brand, type, length }) → record_inspection payloads.
function toRecords(rows, workOrderId, techName, source, today) {
  const date = today || localDate();
  return (rows || []).filter(r => r && String(r.serial || '').trim()).map(row => {
    const rec = {
      serial_num: String(row.serial).trim(),
      tech_name: techName,
      source: source || 'office',
      inspection_date: row.inspection_date || date,
    };
    if (workOrderId && String(workOrderId).trim()) rec.work_order_id = String(workOrderId).trim();
    if (row.brand)         rec.brand = row.brand;
    if (row.type)          rec.type = row.type;
    if (row.length)        rec.length = row.length;
    if (row.next_due_date) rec.next_due_date = row.next_due_date;
    if (row.notes)         rec.notes = row.notes;
    return rec;
  });
}

function errText(e) {
  if (!e) return 'unknown error';
  return e.message || e.details || e.hint || String(e);
}

// Sends records. Returns { written, failed: [{ record, error }] } and never
// throws: a network failure is a failure of every record, reported as such.
async function saveRecords(sb, records) {
  let written = 0;
  const failed = [];
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    let error;
    try { ({ error } = await sb.rpc('record_inspections', { p: batch })); }
    catch (e) { error = e; }
    if (!error) { written += batch.length; continue; }

    // The batch is one transaction, so nothing in it was written. Find out
    // which ladders the server is refusing rather than losing all of them.
    for (const rec of batch) {
      let one;
      try { ({ error: one } = await sb.rpc('record_inspection', { p: rec })); }
      catch (e) { one = e; }
      if (one) failed.push({ record: rec, error: errText(one) });
      else written++;
    }
  }
  return { written, failed };
}

// ── Outbox ──────────────────────────────────────────────────────────────────
// A file that will not parse is moved aside rather than read as empty — the
// next write would otherwise replace it and lose whatever it held.
function readOutbox(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j;
  } catch (_) { /* fall through */ }
  try { fs.renameSync(file, `${file}.unreadable-${Date.now()}`); } catch (_) {}
  return [];
}

// Written to a temporary file and renamed, so a crash mid-write cannot leave
// half a file that reads as an empty outbox and drops everything in it.
function writeOutbox(file, entries) {
  if (!entries.length) { try { fs.unlinkSync(file); } catch (_) {} return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, file);
}

// Saves a finished import's records; whatever fails goes in the outbox under
// `accountId`. Returns { written, failed, queued, errors } — errors is the
// distinct messages, for the run log.
async function recordImport(sb, file, records, accountId, now) {
  const res = await saveRecords(sb, records);
  if (res.failed.length) {
    const at = (now || new Date()).toISOString();
    const box = readOutbox(file);
    res.failed.forEach(f => box.push({ account_id: accountId || null, record: f.record,
                                       error: f.error, first_failed: at, tries: 1 }));
    writeOutbox(file, box);
  }
  return { written: res.written, failed: res.failed.length, queued: res.failed.length,
           errors: [...new Set(res.failed.map(f => f.error))] };
}

// Retries what is waiting for `accountId`. Entries for other accounts are left
// alone and counted. Returns { written, stillFailing, otherAccounts, errors }.
async function flushOutbox(sb, file, accountId) {
  const box = readOutbox(file);
  if (!box.length) return { written: 0, stillFailing: 0, otherAccounts: 0, errors: [] };

  const mine = box.filter(e => (e.account_id || null) === (accountId || null));
  const others = box.filter(e => (e.account_id || null) !== (accountId || null));
  if (!mine.length) return { written: 0, stillFailing: 0, otherAccounts: others.length, errors: [] };

  const res = await saveRecords(sb, mine.map(e => e.record));
  const failedSet = new Map(res.failed.map(f => [f.record, f.error]));
  const kept = mine.filter(e => failedSet.has(e.record))
                   .map(e => ({ ...e, error: failedSet.get(e.record), tries: (e.tries || 1) + 1 }));
  writeOutbox(file, others.concat(kept));
  return { written: res.written, stillFailing: kept.length, otherAccounts: others.length,
           errors: [...new Set(res.failed.map(f => f.error))] };
}

module.exports = { toRecords, saveRecords, recordImport, flushOutbox, readOutbox, localDate };
