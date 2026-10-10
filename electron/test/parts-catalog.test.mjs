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
    partSetsList: async () => ({ ok: true, sets: [
      { id: 'set-1', name: 'Hospital', parts: ['SLS'], ord: 1, mine: true },
      { id: 'set-u', name: 'Batavia standard', parts: ['G13'], ord: 1, mine: false },
    ]}),
    partSetsSave: async (p) => { window.__calls.push({ fn: 'partSetsSave', p });
      return { ok: true, result: { saved: p.sets.length,
        sets: p.sets.map((x, i) => ({ id: x.id || 'new-' + i, name: x.name })) } }; },
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

// ── Button sets ─────────────────────────────────────────────────────────────
ok('the sets are listed beside Main',
   await p.$$eval('#pk-sets .pk-set', e => e.map(x => x.childNodes[0].textContent)),
   ['★ Main', 'Hospital', 'Batavia standard']);
ok('an umbrella\'s set is marked as not this office\'s',
   await p.$$eval('#pk-sets .pk-set', e => /from your umbrella/.test(e[2].textContent)), true);

await p.click('#pk-set-new');
await p.fill('#pk-set-name', 'Ford plant');
await p.click('#pk-set-save'); await p.waitForTimeout(100);
ok('a new set is made and selected',
   await p.$eval('#pk-sets .pk-set.on', e => e.childNodes[0].textContent), 'Ford plant');
ok('and starts with nothing starred',
   await p.$$eval('#pk-chosen .pk-star.on', e => e.length), 0);
const starIn = (num) => p.$$eval('#pk-chosen .pk-row', (rows, n) => {
  rows.find(r => r.querySelector('.pk-num').textContent === n).querySelector('.pk-star').click();
}, num);
await starIn('PM36'); await starIn('SLS'); await p.waitForTimeout(100);
ok('starring puts parts on this set, numbered in the order starred',
   await p.$$eval('#pk-chosen .pk-row', rows => rows.filter(r => r.querySelector('.pk-star.on'))
     .map(r => r.querySelector('.pk-num').textContent + '#' + r.querySelector('.pk-slot').textContent)),
   ['SLS#2', 'PM36#1']);
ok('without touching Main\'s stars', await p.evaluate(() => _pkChosen.find(x => x.partNumber === 'PM36').favorited), false);

await p.click('#pk-set-new');
await p.fill('#pk-set-name', 'hospital');
await p.click('#pk-set-save'); await p.waitForTimeout(100);
ok('two sets cannot share a name', /already a set called/.test(await p.$eval('#pk-msg', e => e.textContent)), true);
await p.$$eval('#pk-set-edit button', e => e.find(x => x.textContent === 'Cancel').click());

// Chips: Main, Hospital, Batavia standard (inherited), Ford plant.
await p.$$eval('#pk-sets .pk-set', e => e[1].click()); await p.waitForTimeout(100);
await p.$$eval('#pk-set-edit button', e => e.find(x => x.textContent === 'Rename').click());
await p.fill('#pk-set-name', 'Hospital — east');
await p.click('#pk-set-save'); await p.waitForTimeout(100);

await p.$$eval('#pk-sets .pk-set', e => e[2].click()); await p.waitForTimeout(100);
ok('an umbrella\'s set cannot be edited here',
   await p.$$eval('#pk-chosen .pk-star', e => e.every(x => x.disabled)), true);

await p.click('#btn-publish-parts'); await p.waitForTimeout(300);
const sets = await p.evaluate(() => window.__calls.filter(c => c.fn === 'partSetsSave').pop().p.sets);
ok('publishing sends this office\'s own sets, not the umbrella\'s', sets.map(x => x.name), ['Hospital — east', 'Ford plant']);
ok('a renamed set keeps its id, so phones keep it', sets[0].id, 'set-1');
ok('a new set goes without one, and its parts in button order', [sets[1].id, sets[1].parts], [null, ['PM36', 'SLS']]);
ok('and the new set is given the id the server returned', await p.evaluate(() => _pkSets.find(x => x.name === 'Ford plant').id), 'new-1');

// ── Removing ────────────────────────────────────────────────────────────────
const before = await p.$$eval('#pk-chosen .pk-row', e => e.length);
await p.$$eval('#pk-chosen .pk-row', rows => {
  const r = rows.find(x => x.querySelector('.pk-num').textContent === 'PM36');
  [...r.querySelectorAll('button')].find(b => b.textContent === 'Remove').click();
});
await p.waitForTimeout(200);
ok('a part can be taken off the list',
   await p.$$eval('#pk-chosen .pk-row', e => e.length), before - 1);
ok('and off every set it was on', await p.evaluate(() => _pkSets.find(x => x.name === 'Ford plant').parts), ['SLS']);

ok('no page errors', errs, []);

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll parts picker assertions passed.');
process.exit(fails ? 1 : 0);
