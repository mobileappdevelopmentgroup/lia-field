// Spare numbers for untagged defective items — reading the lead's list.
//
// Pure — no Electron, no network. main.cjs runs both a chosen CSV and a paste
// through it, so the two are read identically.
//
// What arrives is whatever Batavia issued: sometimes a bare column of numbers,
// usually the whole tracking sheet — one row per number, its Google Sheet
// link, the rep number on every row, and, for a number already spent, what it
// was spent on. Nate's (2026-10-15) has no header row at all. So:
//
//   * The number column is FOUND, not named: the column with the most cells
//     shaped like an assigned number (letters then digits — FP161395, BAT-1001),
//     the leftmost on a tie. A file with none falls back to plain digit runs.
//   * A row is USED when anything besides the number says so. Blanks, "-",
//     spreadsheet errors (#N/A), "SELECT ONE" placeholders, links, the number
//     repeated, and any column that is the same on every row (the rep number)
//     say nothing. A used number still goes up — marked used, so it is never
//     handed out — because a list that drops it would let a later paste load it
//     as free.
'use strict';

const CODE = /^[A-Za-z]{1,8}[- ]?\d{3,}[A-Za-z0-9-]*$/;
const DIGITS = /^\d{3,}$/;
const PLACEHOLDER = /^(-+|—|–|n\/?a|none|tbd|select( one)?|choose( one)?|#.*)$/i;

const key = s => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Text off the clipboard: rows on newlines, cells on tabs (Excel, Sheets) or
// commas (a CSV opened in a text editor).
function splitPaste(text) {
  return String(text || '').split(/\r\n|\r|\n/).map(line => line.split(/\t|,/));
}

function pickColumn(rows) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  let best = -1, bestScore = 0, bestRe = null;
  for (const re of [CODE, DIGITS]) {
    for (let c = 0; c < width; c++) {
      const seen = new Set();
      for (const r of rows) { const v = clean(r[c]); if (re.test(v)) seen.add(key(v)); }
      if (seen.size > bestScore) { best = c; bestScore = seen.size; bestRe = re; }
    }
    if (best >= 0) break;            // a code column beats a digits column
  }
  return { column: best, re: bestRe };
}

function parseSpareNumbers(rows) {
  rows = (rows || []).map(r => (Array.isArray(r) ? r : [r]).map(clean));
  const { column, re } = pickColumn(rows);
  if (column < 0) {
    return { error: 'No assigned numbers found. Expected a column of numbers such as FP161395 or BAT-1001.' };
  }

  const data = rows.map((r, i) => ({ r, row: i + 1 })).filter(x => re.test(x.r[column]));
  // A column with one value on every numbered row (the rep number, the
  // account) describes the list, not the item.
  const width = data.reduce((w, x) => Math.max(w, x.r.length), 0);
  const constant = new Set();
  for (let c = 0; c < width; c++) {
    if (c === column || data.length < 2) continue;
    const vals = new Set(data.map(x => x.r[c] || ''));
    if (vals.size === 1) constant.add(c);
  }

  const seen = new Set();
  const numbers = [];
  let repeated = 0;
  for (const { r, row } of data) {
    const serial = r[column].slice(0, 64);
    const k = key(serial);
    if (seen.has(k)) { repeated++; continue; }
    seen.add(k);
    const evidence = r.filter((v, c) => c !== column && !constant.has(c) && v
      && !PLACEHOLDER.test(v) && !/^https?:\/\//i.test(v) && key(v) !== k);
    numbers.push({ serial, used: evidence.length > 0, row, evidence: evidence.slice(0, 4) });
  }

  const free = numbers.filter(n => !n.used);
  const used = numbers.filter(n => n.used);
  return {
    column: column + 1,
    numbers,
    free: free.map(n => n.serial),
    used: used.map(n => n.serial),
    usedRows: used,
    repeated,
    ignored: rows.filter(r => r.some(Boolean)).length - data.length,
  };
}

module.exports = { parseSpareNumbers, splitPaste };
