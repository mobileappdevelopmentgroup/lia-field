// Where a suggestion list opens.
//
// Reported from a handset: "the drop downs for ladder type, brand and length
// are dropping up. lets change it to drop down. the drop up didnt really
// work." They were pinned upwards by a class in the markup, so Brand and Type
// opened over the serial field the tech had just filled in — and on a short
// screen the top of the list ran off the viewport with no way to reach the
// rest.
//
// Down is now the default and the flip is measured, so this checks both
// directions rather than just the one that was asked for: a list that always
// drops down is the same bug upside down.
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
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1' } } } }); },
    signInWithPassword: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function (fn) {
    if (fn === 'account_snapshot_meta') return Promise.resolve({ data: { total: 1, changed: 1, next_since: '2026-01-01T00:00:00Z' }, error: null });
    if (fn === 'account_snapshot') return Promise.resolve({ data: window.__snapDone ? [] : (window.__snapDone = true, [
      { asset_id: 'a1', serial_raw: 'L-1', serial_key: 'L1', kind: 'ladder', is_deleted: false, updated_at: '2026-01-01T00:00:00Z' }
    ]), error: null });
    if (fn === 'my_jobs') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  },
}; } };`;

const b = await chromium.launch();

// A phone-shaped viewport. The height is the variable under test.
async function open(height) {
  const ctx = await b.newContext({ viewport: { width: 390, height } });
  await ctx.route(/supabase-js@2/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: STUB }));
  await ctx.route(/zxing-browser/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: 'window.ZXingBrowser={};' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(600);
  await p.evaluate(() => LiaSync.pullCatalog({}));
  await p.reload();
  await p.waitForTimeout(700);
  await p.evaluate(() => { LiaSyncState.forgetSyncing(); return LiaSyncState.syncing(); });
  await p.evaluate(() => { const all = loadJobs(); openJob(Object.keys(all)[0]); });
  await p.waitForTimeout(300);
  return { p, ctx, errs };
}

// Reads where the list actually ended up, not merely which class it carries.
const geom = (p, inputId, listId) => p.evaluate(([i, l]) => {
  const input = document.getElementById(i), list = document.getElementById(l);
  const ir = input.getBoundingClientRect(), lr = list.getBoundingClientRect();
  return { open: list.classList.contains('open'), up: list.classList.contains('drop-up'),
           below: lr.top >= ir.bottom - 1, above: lr.bottom <= ir.top + 1,
           maxH: parseFloat(list.style.maxHeight || '0'),
           topInView: lr.top >= -1, bottomInView: lr.bottom <= window.innerHeight + 1 };
}, [inputId, listId]);

// ── Room below: it drops DOWN ───────────────────────────────────────────────
let { p, ctx, errs } = await open(900);
await p.click('#fi-brand');
await p.waitForTimeout(150);
let g = await geom(p, 'fi-brand', 'ac-brand-list');
ok('the Brand list opens', g.open, true);
ok('downwards, not over the serial field above it', g.up, false);
ok('and it is physically below the input', g.below, true);
ok('sized to the room it has', g.maxH > 0, true);
ok('with its bottom on screen', g.bottomInView, true);

// Type behaves the same — it was pinned upwards too.
await p.click('#fi-type');
await p.waitForTimeout(150);
g = await geom(p, 'fi-type', 'ac-type-list');
ok('the Type list also drops down', g.up, false);
ok('and sits below its input', g.below, true);
ok('no page errors', errs, []);
await p.close(); await ctx.close();

// ── No room below: it flips UP rather than running off screen ───────────────
// A short viewport stands in for a tall one with the keyboard up: the same
// squeeze, which is the case the fixed `drop-up` class was there for.
({ p, ctx, errs } = await open(420));
await p.click('#fi-brand');
await p.waitForTimeout(150);
g = await geom(p, 'fi-brand', 'ac-brand-list');
ok('squeezed for room, the list still opens', g.open, true);
ok('and both ends of it are reachable on screen',
   g.topInView && g.bottomInView, true);
ok('it is never taller than the space it is in', g.maxH <= 180, true);
ok('no page errors', errs, []);
await p.close(); await ctx.close();

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll dropdown placement assertions passed.');
process.exit(fails ? 1 : 0);
