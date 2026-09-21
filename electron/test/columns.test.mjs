// Every column Lia Office asks Supabase for has to exist.
//
// Reported from the office: Merge Field Work listed a work order, then showed
// "column inspections.uploaded_at does not exist" instead of the records. The
// column list had been copied from the fall-protection query, which does carry
// `uploaded_at`; `inspections` never has.
//
// No test could catch that, because every desktop test stubs the Supabase
// client and a stub answers to any column name you like. This one reads the
// real column lists out of `electron/main.cjs` and checks them against the
// committed schema snapshot, so a typo or a copied query is caught here rather
// than by a lead standing in front of a work order.
//
// Run via `npm run test:desktop`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');

let fails = 0;
const ok = (l, good, detail) => { if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${detail ? detail + ' — ' : ''}`) + l); };

// ── What the database actually has ──────────────────────────────────────────

const relations = new Map();   // name -> Set(column)

// Tables: pg_dump writes one column per line until the closing paren.
for (const m of SCHEMA.matchAll(/CREATE TABLE public\.(\w+) \(([\s\S]*?)\n\);/g)) {
  const cols = new Set();
  for (const line of m[2].split('\n')) {
    const c = line.match(/^\s{4}(\w+)\s/);
    if (c && !/^CONSTRAINT$/i.test(c[1])) cols.add(c[1]);
  }
  relations.set(m[1], cols);
}

// Views: the output name is the `AS alias` when there is one, otherwise the
// last identifier of the expression. Only the top-level select list counts, so
// stop at the FROM that closes it.
for (const m of SCHEMA.matchAll(/CREATE VIEW public\.(\w+)[^\n]*AS\n([\s\S]*?);\n/g)) {
  const body = m[2];
  const from = body.search(/\n\s+FROM\s/);
  const list = from === -1 ? body : body.slice(0, from);
  const cols = new Set();
  let depth = 0, cur = '';
  for (const ch of list.replace(/^\s*SELECT\s/, '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { cols.add(outName(cur)); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) cols.add(outName(cur));
  cols.delete('');
  relations.set(m[1], cols);
}

function outName(expr) {
  const alias = expr.match(/\sAS\s+"?(\w+)"?\s*$/i);
  if (alias) return alias[1];
  const trailing = expr.trim().match(/(\w+)$/);
  return trailing ? trailing[1] : '';
}

// Every relation the snapshot declares has to come out of the parse, or a
// query against a missed one would sail through unchecked.
const declared = (SCHEMA.match(/^CREATE (?:TABLE|VIEW) public\./gm) || []).length;
ok('every relation in the snapshot parsed', relations.size === declared,
   `${declared} declared, ${relations.size} parsed`);
ok('inspections is in it', relations.has('inspections'));
ok('and the view the merge screen lists work orders from is too',
   relations.has('work_order_submissions'));

// The bug itself, stated plainly: these two tables differ, and the difference
// is what broke.
ok('fp_inspections has uploaded_at', relations.get('fp_inspections')?.has('uploaded_at'));
ok('inspections does NOT — created_at is its server timestamp',
   !relations.get('inspections')?.has('uploaded_at') &&
   relations.get('inspections')?.has('created_at'));

// ── What the office asks for ────────────────────────────────────────────────
// `.from('x')` followed by the next `.select('...')`. Both are written on one
// line each throughout main.cjs; a select spanning lines would simply not be
// picked up, which fails open rather than falsely.

const queries = [];
const lines = MAIN.split('\n');
lines.forEach((line, i) => {
  const f = line.match(/\.from\('(\w+)'\)/);
  if (!f) return;
  // The select is on this line or the next couple.
  for (let j = i; j < Math.min(i + 3, lines.length); j++) {
    const s = lines[j].match(/\.select\('([^']*)'/);
    if (s) { queries.push({ table: f[1], select: s[1], line: j + 1 }); return; }
  }
});

ok('found the office\'s queries', queries.length >= 8, `found ${queries.length}`);

// An embedded resource — `assets(serial_raw)` — is a join, so its columns
// belong to that table, not the one being queried.
function checkSelect({ table, select, line }) {
  let rest = select, depth = 0, cur = '', parts = [];
  for (const ch of rest) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  for (const raw of parts) {
    const part = raw.trim();
    if (!part || part === '*') continue;
    const embed = part.match(/^(\w+)\s*\(([^)]*)\)$/);
    if (embed) {
      for (const sub of embed[2].split(',')) {
        checkColumn(embed[1], sub.trim(), line);
      }
      continue;
    }
    // PostgREST aliasing: `alias:real_column`.
    checkColumn(table, part.includes(':') ? part.split(':')[1].trim() : part, line);
  }
}

function checkColumn(table, col, line) {
  if (!col || col === '*') return;
  const cols = relations.get(table);
  if (!cols) {
    return ok(`main.cjs:${line} — ${table} is a known relation`, false,
              `no CREATE TABLE or CREATE VIEW for ${table}`);
  }
  ok(`main.cjs:${line} — ${table}.${col}`, cols.has(col),
     `${table} has no column ${col}`);
}

queries.forEach(checkSelect);

console.log(fails ? `\n${fails} failed` : '\nEvery column the office asks for exists.');
process.exit(fails ? 1 : 0);
