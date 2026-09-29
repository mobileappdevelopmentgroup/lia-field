// Turn the BSI price-list pull into the catalogue the field app ships.
//
// Takes only the part number and its description. The prices in the same rows
// are Batavia's and stay out of anything installed on a phone or committed to
// this repo — they are for estimating in Lia Office.
//
// 11,079 rows collapse to 1,936 parts: BSI prices the same part per customer
// type, 23 of them, so the rows are a price matrix rather than a catalogue.
//
//   node tools/bsi-products.mjs /somewhere/bsi-products.json
//   node tools/build-parts-catalog.mjs /somewhere/bsi-products.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = process.argv[2];
// Both apps need it: the phone to autocomplete and describe, and Lia Office
// so a lead builds their crew's list by picking from what BSI will actually
// pay for. electron/** is what electron-builder packages, so the office copy
// lives there rather than being reached across the repo.
const OUT  = path.join(ROOT, 'field-app', 'js', 'parts-catalog.js');
const OUT2 = path.join(ROOT, 'electron', 'parts-catalog.js');

if (!SRC || !fs.existsSync(SRC)) {
  console.error('Give me the file tools/bsi-products.mjs wrote.');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// Same part number under several customer types: one entry, the longest
// description, because the short ones are usually truncated.
const byPart = new Map();
for (const p of raw.parts) {
  const n = (p.partNumber || '').trim();
  if (!n) continue;
  const d = (p.description || '').trim();
  const cur = byPart.get(n);
  if (!cur || d.length > cur.length) byPart.set(n, d);
}

const parts = [...byPart.entries()]
  .sort((a, z) => a[0].localeCompare(z[0], undefined, { numeric: true, sensitivity: 'base' }));

const body = parts.map(([n, d]) => `  [${JSON.stringify(n)},${JSON.stringify(d)}],`).join('\n');

fs.writeFileSync(OUT, `// Lia Field — parts-catalog.js
//
// GENERATED. Do not edit by hand.
//   node tools/bsi-products.mjs <out.json>
//   node tools/build-parts-catalog.mjs <out.json>
//
// Every part number BSI knows, with its description — ${parts.length} of them,
// pulled ${raw.pulledAt.slice(0, 10)} from the live price list.
//
// BSI's list is ${raw.recordsTotal} rows because it prices each part per customer
// type. That is a price matrix, not a catalogue: the same part number appears
// under 23 customer types at different money. Only the number and the
// description are here. **Prices are deliberately absent** — they are
// Batavia's, they belong in Lia Office for estimating, and a phone gets left
// in a van.
//
// This is a REFERENCE list, not the tech's library. getLibrary() merges it in
// without disturbing favourites, their order, or parts a tech added.
//
// Part of the field app. These are CLASSIC scripts, not modules.

const PARTS_CATALOG = [
${body}
];

// Descriptions, looked up by part number, case-insensitively — techs type
// "lgh123wp" and BSI writes "LGH123WP".
const PARTS_DESC = (function () {
  const m = Object.create(null);
  for (let i = 0; i < PARTS_CATALOG.length; i++) m[PARTS_CATALOG[i][0].toLowerCase()] = PARTS_CATALOG[i][1];
  return m;
})();

function partDescription(name) {
  return PARTS_DESC[String(name || '').trim().toLowerCase()] || '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PARTS_CATALOG, partDescription };
}
`);

fs.copyFileSync(OUT, OUT2);

const bytes = fs.statSync(OUT).size;
console.log(`${parts.length} parts → ${path.relative(ROOT, OUT)}`);
console.log(`${parts.length} parts → ${path.relative(ROOT, OUT2)} (${(bytes / 1024).toFixed(0)} KB each)`);
