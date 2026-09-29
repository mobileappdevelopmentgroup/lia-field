// Pull BSI's whole price list — 11,079 parts — so the catalogue in the field
// app can be the real one instead of the handful of part numbers that were
// typed in by hand.
//
// It reads the table's own server-side endpoint rather than scraping 444 pages
// of rendered HTML. Read-only: a GET per page, nothing written back, no work
// order touched. Prices come along because they are in the same row and are
// the answer to a question we will eventually be asked.
//
// Needs a logged-in browser from tools/bsi-session.mjs.
//
//   node tools/bsi-products.mjs [out.json]
import { chromium } from 'playwright';
import fs from 'fs';

const OUT  = process.argv[2] || 'bsi-products.json';
const STEP = 2000;

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
let page = ctx.pages().find(x => /bsiwebapp\.com/.test(x.url()));
if (!page) { page = await ctx.newPage(); await page.goto('https://bsiwebapp.com/products/list/'); await page.waitForTimeout(2000); }
// DataTables pops a confirm on some actions; never let one block the page.
page.on('dialog', d => d.dismiss().catch(() => {}));

const fetchPage = (start, length) => page.evaluate(async ([s, l]) => {
  const q = new URLSearchParams();
  q.set('draw', '1'); q.set('start', String(s)); q.set('length', String(l));
  ['id', 'custtype', 'partnumber', 'description', 'materials', 'labor'].forEach((n, i) => {
    q.set(`columns[${i}][data]`, String(i));
    q.set(`columns[${i}][name]`, n);
    q.set(`columns[${i}][searchable]`, 'true');
    q.set(`columns[${i}][orderable]`, 'true');
    q.set(`columns[${i}][search][value]`, '');
    q.set(`columns[${i}][search][regex]`, 'false');
  });
  q.set('order[0][column]', '0'); q.set('order[0][dir]', 'asc');
  q.set('search[value]', ''); q.set('search[regex]', 'false');
  const res = await fetch('/modules/products/list/show-products.php?' + q.toString(),
                          { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}, [start, length]);

const first = await fetchPage(0, 1);
const total = first.recordsTotal;
console.log(`${total} parts to pull`);

const seen = new Map();
const gaps = [];

// The endpoint gives up on some ranges — it answered a 2000-row window with a
// PHP warning instead of JSON. So a failed window is halved and retried, and
// only a single row that will not come back is recorded as a gap. Reporting
// what is missing beats a file that looks complete and is not.
async function pull(start, length) {
  try {
    const j = await fetchPage(start, length);
    return j.data || [];
  } catch (err) {
    if (length <= 1) { gaps.push(start); return []; }
    const half = Math.ceil(length / 2);
    return [...await pull(start, half), ...await pull(start + half, length - half)];
  }
}

for (let start = 0; start < total; start += STEP) {
  const rows = await pull(start, Math.min(STEP, total - start));
  rows.forEach(r => {
    const part = (r['2'] || '').trim();
    if (!part) return;
    // The same part number is priced per customer type, so the row key is the
    // pair. Collapsing on part number alone would silently pick one price.
    seen.set(`${r['1']}\u0000${part}`, {
      id: Number(r['0']) || null,
      custType:    (r['1'] || '').trim(),
      partNumber:  part,
      description: (r['3'] || '').trim(),
      materials:   (r['4'] || '').trim(),
      labor:       (r['5'] || '').trim(),
    });
  });
  process.stdout.write(`\r  ${Math.min(start + STEP, total)}/${total} (${seen.size} kept)`);
}
console.log();
if (gaps.length) console.log(`  ${gaps.length} row(s) the server would not return: ${gaps.slice(0,20).join(', ')}`);

const parts = [...seen.values()];
fs.writeFileSync(OUT, JSON.stringify({
  source: 'bsiwebapp.com/products/list',
  pulledAt: new Date().toISOString(),
  recordsTotal: total, count: parts.length, missingRows: gaps, parts,
}, null, 2));

const byType = {};
parts.forEach(p => { byType[p.custType] = (byType[p.custType] || 0) + 1; });
console.log(`wrote ${parts.length} rows → ${OUT}`);
console.log('customer types:', Object.entries(byType).sort((a, z) => z[1] - a[1])
  .map(([k, v]) => `${k}:${v}`).join('  '));

const fp = parts.filter(p => /^FP\d+$/i.test(p.partNumber));
console.log(`\nFP parts (${fp.length}):`);
fp.sort((a, z) => (parseInt(a.partNumber.slice(2)) - parseInt(z.partNumber.slice(2))) || a.custType.localeCompare(z.custType))
  .forEach(p => console.log(`  ${p.partNumber.padEnd(6)} ${p.description.padEnd(34)} [${p.custType}] ${p.materials}/${p.labor}`));
await b.close();
