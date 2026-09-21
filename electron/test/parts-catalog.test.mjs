// The lead builds their crew's parts list.
//
// Picked from BSI, because a part BSI has never heard of is a part that does
// not get paid. A lead can still type one in — they know their own work better
// than the price list does — and it is MARKED rather than refused, because
// finding out on an invoice is how this goes wrong.
//
// Run with `npm run test:desktop`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(ROOT, 'electron', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(ROOT, 'electron')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port;

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(() => {
  window.__calls = [];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    partsList: async () => ({ ok: true, parts: [
      { part_number: 'SLS', description: 'SIDE RAIL', favorited: true, default_qty: 2, ord: 1, is_deleted: false },
    ]}),
    partsSave: async (p) => { window.__calls.push({ fn: 'partsSave', p }); return { ok: true, result: { saved: p.parts.length } }; },
    fpListTypes: async () => ({ ok: true, types: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    fieldList: async () => ({ ok: true, workOrders: [] }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
  };
});

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);

// BSI's list has to actually be in the office build, not only in the phone's.
ok('Lia Office carries BSI\'s part list',
   await p.evaluate(() => typeof PARTS_CATALOG !== 'undefined' && PARTS_CATALOG.length > 1900), true);

await p.evaluate(() => { showScreen('catalog'); catTab('parts'); });
await p.waitForTimeout(400);

ok('the crew\'s current list is loaded',
   await p.$$eval('#pk-chosen .pk-row', e => e.length), 1);
ok('with the quantity already set on it',
   await p.$eval('#pk-chosen .pk-qty', e => e.value), '2');

// ── Searching BSI ───────────────────────────────────────────────────────────
await p.fill('#pk-search', 'PM36');
await p.waitForTimeout(250);
ok('searching BSI by part number finds it',
   await p.$$eval('#pk-results .pk-num', e => e.map(x => x.textContent)).then(x => x.includes('PM36')), true);

// A description is how a lead finds a part whose number they do not know.
await p.fill('#pk-search', 'GRAB RAIL');
await p.waitForTimeout(250);
ok('and searching by description works too',
   await p.$$eval('#pk-results .pk-row', e => e.length > 0), true);

await p.fill('#pk-search', 'PM36');
await p.waitForTimeout(250);
await p.click('#pk-results button');
await p.waitForTimeout(250);
ok('picking one adds it to the list',
   await p.$$eval('#pk-chosen .pk-num', e => e.map(x => x.textContent)).then(x => x.includes('PM36')), true);
ok('and it is not offered twice',
   await p.$$eval('#pk-results button', e => e.every(x => x.disabled)), true);

// ── A part BSI does not know ────────────────────────────────────────────────
await p.fill('#pk-search', 'ZZZ-NOT-A-REAL-PART');
await p.waitForTimeout(250);
ok('a part BSI has never heard of is still offered',
   await p.$$eval('#pk-results button', e => e.length), 1);
ok('and is named as one that will not bill',
   /will not bill/i.test(await p.$eval('#pk-results', e => e.textContent)), true);

await p.click('#pk-results button');
await p.waitForTimeout(250);
ok('adding it works',
   await p.$$eval('#pk-chosen .pk-num', e => e.map(x => x.textContent)).then(x => x.includes('ZZZ-NOT-A-REAL-PART')), true);
ok('and it carries the warning in the list, not just at the moment of adding',
   await p.$$eval('#pk-chosen .pk-off', e => e.length), 1);
ok('while the BSI parts beside it carry none',
   await p.$$eval('#pk-chosen .pk-row', rows =>
     rows.filter(r => r.querySelector('.pk-off')).length), 1);

// ── Publishing ──────────────────────────────────────────────────────────────
await p.click('#btn-publish-parts');
await p.waitForTimeout(300);

const sent = await p.evaluate(() => window.__calls.find(c => c.fn === 'partsSave').p.parts);
ok('everything picked is sent', sent.length, 3);
ok('with an explicit order, so the phone does not have to guess one',
   sent.map(x => x.ord), [1, 2, 3]);
ok('and the quantities the lead set',
   sent.find(x => x.partNumber === 'SLS').defaultQty, 2);
ok('the lead is told it reaches phones on the next sync, not instantly',
   /next time their phones sync/i.test(await p.$eval('#pk-msg', e => e.textContent)), true);
ok('and is reminded what will not bill',
   /1 part is not in BSI and will not bill/i.test(await p.$eval('#pk-msg', e => e.textContent)), true);

// ── Removing ────────────────────────────────────────────────────────────────
const before = await p.$$eval('#pk-chosen .pk-row', e => e.length);
await p.$$eval('#pk-chosen .pk-row', rows => {
  const r = rows.find(x => x.querySelector('.pk-num').textContent === 'PM36');
  [...r.querySelectorAll('button')].find(b => b.textContent === 'Remove').click();
});
await p.waitForTimeout(200);
ok('a part can be taken off the list',
   await p.$$eval('#pk-chosen .pk-row', e => e.length), before - 1);

ok('no page errors', errs, []);

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll parts picker assertions passed.');
process.exit(fails ? 1 : 0);
