// The real parts catalogue, on a phone.
//
// The library was ~30 part numbers somebody typed in. A tech working a job
// with anything else got no autocomplete and no description, so the part went
// in as free text and the importer had to guess. This brings BSI's own list —
// 1,936 parts, pulled from the live price list.
//
// Two things have to hold, and both are the sort that fail quietly:
//
//   * A tech's favourites, their slot order and parts they added by hand
//     survive the catalogue arriving. Assigning the new list over the old one
//     would wipe the arrangement somebody made for their own hands, on an
//     app they use with gloves on, and nothing would report it.
//   * 1,936 entries are not all favourited. Favouriting everything is the
//     same as favouriting nothing.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('config.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ supabase: { url: 'https://x.supabase.co', anonKey: 'k' } }));
  }
  const file = path.join(ROOT, 'field-app', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(ROOT, 'field-app')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port;

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const STUB = `
window.supabase = { createClient: function () { return {
  auth: {
    getSession: function () { return Promise.resolve({ data: { session: null } }); },
    signInWithPassword: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function () { return Promise.resolve({ data: null, error: null }); },
}; } };`;

const b = await chromium.launch();
async function open(seedLocalStorage) {
  const ctx = await b.newContext();
  if (seedLocalStorage) await ctx.addInitScript(seedLocalStorage);
  await ctx.route(/supabase-js@2/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: STUB }));
  await ctx.route(/zxing-browser/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: 'window.ZXingBrowser={};' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(700);
  return { p, ctx, errs };
}

// ── A fresh install gets the whole catalogue ────────────────────────────────
let { p, ctx, errs } = await open(null);

ok('the catalogue is loaded', await p.evaluate(() => PARTS_CATALOG.length > 1900), true);
ok('and it carries descriptions, not just numbers',
   await p.evaluate(() => partDescription('LGH125ILC')), 'LEG CAP FOR FOOT REP INT');
ok('looked up case-insensitively, the way a tech types it',
   await p.evaluate(() => partDescription('lgh125ilc') === partDescription('LGH125ILC')), true);
ok('an unknown part gives an empty string rather than undefined',
   await p.evaluate(() => partDescription('NOT-A-PART')), '');

ok('the library holds the whole catalogue',
   await p.evaluate(() => getLibrary().length > 1900), true);
ok('the seed\'s own favourites are still favourited',
   await p.evaluate(() => {
     const fav = new Set(getFavoritedParts().map(x => x.name.toLowerCase()));
     return ['m23', 'm16', 'rc', 'sls'].every(n => fav.has(n));
   }), true);
ok('and the catalogue did NOT favourite 1,936 things',
   await p.evaluate(() => getFavoritedParts().length < 30), true);
ok('no page errors', errs, []);
await p.close(); await ctx.close();

// ── An install from before the catalogue existed ────────────────────────────
// The case that matters: somebody who has been using this for months, with
// their own parts and their own order.
({ p, ctx, errs } = await open(`
  localStorage.setItem('lia-parts-library', JSON.stringify([
    { name: 'M23',      favorited: true,  defaultQty: 1, order: 2 },
    { name: 'SLS',      favorited: true,  defaultQty: 4, order: 1 },
    { name: 'MYOWNPART',favorited: true,  defaultQty: 3, order: 3 },
    { name: 'M13',      favorited: false, defaultQty: 1 }
  ]));
`));

ok('their hand-added part is still there',
   await p.evaluate(() => getLibrary().some(x => x.name === 'MYOWNPART')), true);
ok('still favourited, with the quantity they set',
   await p.evaluate(() => {
     const x = getLibrary().find(y => y.name === 'MYOWNPART');
     return [x.favorited, x.defaultQty];
   }), [true, 3]);
ok('their slot order is untouched',
   await p.evaluate(() => getFavoritedParts().map(x => x.name)),
   ['SLS', 'M23', 'MYOWNPART']);
ok('a quantity they changed is not reset to the seed\'s',
   await p.evaluate(() => getLibrary().find(x => x.name === 'SLS').defaultQty), 4);
ok('and the catalogue arrived behind all that',
   await p.evaluate(() => getLibrary().length > 1900), true);
ok('without favouriting any of it',
   await p.evaluate(() => getFavoritedParts().length), 3);
ok('no page errors', errs, []);

// Re-reading is stable — a merge that re-adds every time would grow the
// library without bound and rewrite localStorage on every call.
const first = await p.evaluate(() => getLibrary().length);
const again = await p.evaluate(() => { getLibrary(); return getLibrary().length; });
ok('merging is idempotent', again, first);
await p.close(); await ctx.close();

// ── The lead publishes a list from Lia Office ───────────────────────────────
// Same rule again, and this is the one that would hurt: the lead publishes on
// a Tuesday and every tech's quick buttons rearrange themselves mid-job.
({ p, ctx, errs } = await open(`
  localStorage.setItem('lia-parts-library', JSON.stringify([
    { name: 'M23',   favorited: true,  defaultQty: 1, order: 1, touched: true },
    { name: 'MINE',  favorited: true,  defaultQty: 7, order: 2, touched: true },
    { name: 'G13',   favorited: false, defaultQty: 1, fromCatalog: true },
    { name: 'W44',   favorited: false, defaultQty: 1, fromCatalog: true }
  ]));
`));

const published = [
  // New to the device, and the lead suggests it as a quick button.
  { part_number: 'PM36', description: 'PIVOT MOUNT', favorited: true, default_qty: 1, ord: 1, is_deleted: false },
  // Already there, untouched by the tech: the lead's quantity may apply.
  { part_number: 'G13',  description: 'GRAB RAIL',   favorited: false, default_qty: 4, ord: 2, is_deleted: false },
  // Already there, and the tech has made it theirs. Hands off.
  { part_number: 'MINE', description: 'WHATEVER',    favorited: false, default_qty: 1, ord: 3, is_deleted: false },
];
await p.evaluate((rows) => mergeCrewParts(rows), published);

ok('a part the lead published arrives',
   await p.evaluate(() => getLibrary().some(x => x.name === 'PM36')), true);
ok('with the lead\'s suggested quick button',
   await p.evaluate(() => getLibrary().find(x => x.name === 'PM36').favorited), true);
ok('an untouched part takes the lead\'s quantity',
   await p.evaluate(() => getLibrary().find(x => x.name === 'G13').defaultQty), 4);

// The point of the whole thing.
ok('a part the TECH set is left alone',
   await p.evaluate(() => {
     const x = getLibrary().find(y => y.name === 'MINE');
     return [x.favorited, x.defaultQty];
   }), [true, 7]);
ok('and their own favourite is still pinned',
   await p.evaluate(() => getFavoritedParts().some(x => x.name === 'M23')), true);

ok('publishing the same list twice changes nothing the second time',
   await p.evaluate((rows) => {
     const before = JSON.stringify(getLibrary());
     mergeCrewParts(rows);
     return JSON.stringify(getLibrary()) === before;
   }, published), true);

// ── The lead withdraws one ──────────────────────────────────────────────────
// Withdrawing is taking back a SUGGESTION, not deleting a part. G13 is a real
// BSI part: it stays in the library, searchable and billable, because a tech
// who reaches for it must still find it. Only the lead's pin and quantity go.
// (The first version of this deleted it outright, and the BSI catalogue simply
// put it back on the next read — a withdrawal that could never take.)
await p.evaluate(() => mergeCrewParts([
  { part_number: 'PM36', is_deleted: true },
  { part_number: 'G13',  is_deleted: true },
  { part_number: 'MINE', is_deleted: true },
]));

ok('a withdrawn BSI part is still in the library',
   await p.evaluate(() => getLibrary().some(x => x.name === 'G13')), true);
ok('but the lead\'s quantity is taken back with it',
   await p.evaluate(() => getLibrary().find(x => x.name === 'G13').defaultQty), 1);
ok('and a pin the LEAD put there is unpinned',
   await p.evaluate(() => getLibrary().find(x => x.name === 'PM36').favorited), false);
ok('a part the tech had made theirs is left entirely alone',
   await p.evaluate(() => {
     const x = getLibrary().find(y => y.name === 'MINE');
     return [x.favorited, x.defaultQty];
   }), [true, 7]);
ok('no page errors', errs, []);
await p.close(); await ctx.close();

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll parts catalogue assertions passed.');
process.exit(fails ? 1 : 0);
