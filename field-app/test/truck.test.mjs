// My truck: the trucks a tech is on, and use / load / count from the phone.
//
// The server is stubbed as the Supabase script itself (see boot.test.mjs), and
// records what the phone sends. What matters here:
//   * the trucks come down with the catalogue and survive no signal;
//   * every change is queued (never dropped, never holding up an inspection)
//     and shown at once, on top of the last numbers from the server;
//   * a count is sent as a count, with when it was taken — the server does
//     the arithmetic;
//   * signing out takes one company's trucks off the phone.
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

// my_vehicles() as the server would answer, and a log of what was sent.
const stub = `
window.__sent = [];
window.__vehicles = {
  fetched_at: '2026-10-11T08:00:00Z', auto_deduct: true,
  vehicles: [
    { id: 'v14', name: 'Truck 14', unit: 'KXP-221', primary: true, loadout: 'Ladder truck',
      lines: [ { part_number: 'G13', qty: 6, par: 10, need: 4 }, { part_number: 'W44', qty: 4, par: 4, need: 0 } ] },
    { id: 'v9', name: 'Truck 9', unit: null, primary: false, loadout: null, lines: [] } ],
  warehouses: [ { id: 'wh', name: 'Shop' } ] };
window.supabase = { createClient: function () { return {
  auth: {
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 't@x' } } } }); },
    signOut: function () { return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function (fn, args) {
    if (fn === 'my_vehicles') return Promise.resolve(window.__down ? { data: null, error: { message: 'offline' } }
                                                                  : { data: window.__vehicles, error: null });
    if (fn === 'record_stock_move' || fn === 'set_my_truck') {
      if (window.__down) return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
      window.__sent.push({ fn: fn, args: args });
      return Promise.resolve({ data: { id: 'x' }, error: null });
    }
    if (fn === 'account_snapshot_meta') return Promise.resolve({ data: { total: 0, changed: 0, next_since: null }, error: null });
    if (fn === 'account_snapshot') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  },
}; } };`;

const b = await chromium.launch();
const ctx = await b.newContext();
await ctx.route(/supabase-js@2/, r => r.fulfill({ status: 200, contentType: 'text/javascript',
  headers: { 'cache-control': 'no-store' }, body: stub }));
await ctx.route(/zxing-browser/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.ZXingBrowser={};' }));
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(BASE + '/index.html');
await p.waitForTimeout(600);
await p.evaluate(() => LiaSync.pullCatalog({}));
await p.evaluate(() => { goScreen('jobs'); renderJobList(); });
await p.waitForTimeout(200);

// ── The card, and the screen ────────────────────────────────────────────────
ok('the trucks come down with the catalogue', await p.evaluate(() => LiaTruck.vehicles().map(v => v.name)), ['Truck 14', 'Truck 9']);
ok('a tech on a truck sees it on the jobs screen, with what it is short',
   await p.$eval('#truck-card', e => [e.style.display !== 'none', /Truck 14/.test(e.textContent), /1 short/.test(e.textContent)]),
   [true, true, true]);
await p.click('#truck-card'); await p.waitForTimeout(250);
ok('it opens My truck on the truck that is theirs today',
   await p.evaluate(() => [document.querySelector('#screen-truck').classList.contains('active'), $('truck-title').textContent]),
   [true, 'Truck 14 · KXP-221']);
ok('listing each part with what is on it', await p.$$eval('#truck-list .truck-row', rs => rs.map(r =>
   r.querySelector('.tr-pn').textContent + '=' + r.querySelector('.tr-qty').textContent)), ['G13=6', 'W44=4']);
ok('a line under par is marked short', await p.$$eval('#truck-list .truck-row.short .tr-pn', e => e.map(x => x.textContent)), ['G13']);
ok('and the tech is told ladder parts come off this truck',
   /come off this truck/.test(await p.$eval('#truck-asof', e => e.textContent)), true);

// ── Use, load, count — offline ──────────────────────────────────────────────
await p.evaluate(() => { window.__down = true; });
const row = (pn, act) => p.$$eval('#truck-list .truck-row', (rs, a) => {
  rs.find(r => r.dataset.part === a[0]).querySelector(`[data-act="${a[1]}"]`).click(); }, [pn, act]);
await row('G13', 'use'); await p.waitForTimeout(100);
ok('−1 takes one off at once', await p.$eval('#truck-list [data-part="G13"] .tr-qty', e => e.textContent), '5');
ok('and says it has not uploaded yet', /not uploaded yet/.test(await p.$eval('#truck-list [data-part="G13"]', e => e.textContent)), true);
const q1 = await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue')).filter(e => e.kind === 'stock_move'));
ok('it is queued as a stock move', q1.map(e => [e.payload.reason, e.payload.part_number, e.payload.qty, e.payload.location_id]),
   [['use', 'G13', 1, 'v14']]);

await row('W44', 'load'); await p.waitForTimeout(150);
ok('Load asks how many, and offers the warehouses', await p.evaluate(() => [
   !$('truck-sheet').classList.contains('hidden'), [...$('truck-sheet-from').options].map(o => o.textContent)]),
   [true, ['Not from a warehouse', 'From Shop']]);
await p.fill('#truck-sheet-qty', '3');
await p.selectOption('#truck-sheet-from', 'wh');
await p.click('#truck-sheet-ok'); await p.waitForTimeout(100);
ok('a load adds on', await p.$eval('#truck-list [data-part="W44"] .tr-qty', e => e.textContent), '7');

await row('G13', 'count'); await p.waitForTimeout(150);
await p.fill('#truck-sheet-qty', '9');
await p.click('#truck-sheet-ok'); await p.waitForTimeout(100);
ok('a count sets the number', await p.$eval('#truck-list [data-part="G13"] .tr-qty', e => e.textContent), '9');
const q2 = await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue')).filter(e => e.kind === 'stock_move').map(e => e.payload));
ok('the load names its warehouse', [q2[1].reason, q2[1].qty, q2[1].from_location_id], ['load', 3, 'wh']);
ok('the count is sent as a count, with when it was taken',
   [q2[2].reason, q2[2].counted_qty, q2[2].qty, typeof q2[2].captured_at], ['count', 9, null, 'string']);
await row('G13', 'use'); await p.waitForTimeout(100);
ok('a use after a count comes off the counted number', await p.$eval('#truck-list [data-part="G13"] .tr-qty', e => e.textContent), '8');

await p.fill('#truck-new-part', 'pm36'); await p.click('#truck-new-go'); await p.waitForTimeout(150);
await p.fill('#truck-sheet-qty', '2'); await p.click('#truck-sheet-ok'); await p.waitForTimeout(100);
ok('a part not on the list can be loaded onto it', await p.$eval('#truck-list [data-part="PM36"] .tr-qty', e => e.textContent), '2');

// ── An inspection is never held up by a truck change ────────────────────────
ok('a failed truck change does not block the queue — it is stepped aside, not dropped',
   await p.evaluate(async () => { await LiaSync.drain({}).catch(() => {}); return JSON.parse(localStorage.getItem('lia-upload-queue'))
     .filter(e => e.kind === 'stock_move').length; }), 5);

// ── Signal comes back ───────────────────────────────────────────────────────
await p.evaluate(() => { window.__down = false;
  // What the server would say after taking the five changes.
  window.__vehicles.vehicles[0].lines = [ { part_number: 'G13', qty: 8, par: 10, need: 2 },
    { part_number: 'PM36', qty: 2, par: null, need: 0 }, { part_number: 'W44', qty: 7, par: 4, need: 0 } ]; });
await p.evaluate(() => LiaSync.drain({}));
await p.waitForTimeout(500);
// In any order: a retry steps deferrable entries aside, and the server orders
// a truck's changes by when they were made, not when they arrived.
ok('every change reaches the server, once', await p.evaluate(() => window.__sent.map(s => s.args.p.reason).sort()),
   ['count', 'load', 'load', 'use', 'use']);
ok('the queue is empty', await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue')).length), 0);
ok('the numbers on screen are the server\'s, not counted twice',
   await p.$$eval('#truck-list .truck-row', rs => rs.map(r => r.dataset.part + '=' + r.querySelector('.tr-qty').textContent)),
   ['G13=8', 'PM36=2', 'W44=7']);
ok('nothing is shown as waiting any more', await p.evaluate(() => LiaTruck.pending().length), 0);

// ── Which truck is mine today ───────────────────────────────────────────────
await p.click('[data-truck="v9"]'); await p.waitForTimeout(100);
ok('another truck can be looked at', await p.$eval('#truck-title', e => e.textContent), 'Truck 9');
await p.click('#truck-mine'); await p.waitForTimeout(100);
await p.evaluate(() => LiaSync.drain({})); await p.waitForTimeout(200);
ok('and made theirs for the day', await p.evaluate(() => window.__sent.filter(s => s.fn === 'set_my_truck').map(s => s.args.p_location)), ['v9']);

// ── Signing out ─────────────────────────────────────────────────────────────
await p.evaluate(() => LiaSync.signOut());
await p.waitForTimeout(150);
ok('signing out takes the company\'s trucks off the phone', await p.evaluate(() => [LiaTruck.vehicles().length, localStorage.getItem(LiaTruck.KEY)]), [0, null]);
await p.evaluate(() => { goScreen('jobs'); renderJobList(); });
ok('and the card with them', await p.$eval('#truck-card', e => e.style.display), 'none');

ok('no page errors', errs, []);
await b.close(); server.close();
console.log(fails ? `\nRESULT: ${fails} failure(s)` : '\nRESULT: all passed');
process.exit(fails ? 1 : 0);
