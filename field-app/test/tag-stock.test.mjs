// The lead's blank tags on the phone (tag-stock.js, migrations 28/29).
//
// A blank tag's chip carries a Google Sheet link, which is exactly what a
// supplier's tag looks like. Without the stock list, a tech tapping his own
// blank tag is sent to read somebody else's sheet. These are the ways that
// must not happen, plus the list's own behaviour.
//
// Served over HTTP because the capture screen leans on IndexedDB and fetch.
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
  if (url.endsWith('config.json')) { res.writeHead(404); return res.end(); }
  const file = path.join(ROOT, 'field-app', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(ROOT, 'field-app')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errs.push('console: ' + m.text()); });
let fails = 0;
const ok = (l,g,w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

// Every request to Google is counted and answered with an empty sheet. A tap on
// one of our own blank tags must cause none.
let googleHits = 0;
await p.route('https://docs.google.com/**', route => { googleHits++; route.fulfill({ status: 200, contentType: 'text/csv', body: '' }); });

// Android NFC stand-in, as in fp-batch.test.mjs, so tap-through is wired.
await p.addInitScript(() => {
  const listeners = {};
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { NFC: {
      startScan: async () => { throw new Error("Android NFC scanning does not require 'startScan' method."); },
      cancelScan: () => Promise.reject(new Error('not implemented')),
      writeNDEF: async () => {},
      addListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn);
        return Promise.resolve({ remove: () => { listeners[name] = (listeners[name]||[]).filter(f => f !== fn); } }); },
    } },
  };
  const b64 = a => btoa(String.fromCharCode.apply(null, a));
  const u8 = s => Array.from(new TextEncoder().encode(s));
  window.__tap = (opts) => {
    const records = [];
    if (opts.url) records.push({ type: 'U', payload: b64([0x04].concat(u8(opts.url.replace(/^https:\/\//,'')))) });
    (listeners.nfcTag || []).forEach(fn => fn({
      messages: records.length ? [{ records }] : [],
      tagInfo: opts.uid ? { uid: opts.uid } : undefined,
    }));
  };
});

const LINK = n => `https://docs.google.com/spreadsheets/d/stock${n}/edit?usp=drivesdk`;

await p.goto(BASE);
await p.waitForTimeout(400);

// ── The list itself ─────────────────────────────────────────────────────────
ok('the pull stores what the server sends', await p.evaluate(async (L) => LiaTagStock.pull({
  rpc: async (name) => name === 'my_tag_stock'
    ? { data: [ { tag_label: 'FP161340', tag_url: L[0] },
                { tag_label: 'FP161341', tag_url: L[1] },
                { tag_label: 'FP161342', tag_url: L[2] },
                { tag_label: 'FP161343', tag_url: L[3] } ] }
    : { error: { message: 'unexpected ' + name } },
}), [LINK('A'), LINK('B'), LINK('C'), LINK('D')]), 4);
ok('a failed pull never rejects and keeps what the phone had',
   await p.evaluate(async () => [await LiaTagStock.pull({ rpc: async () => { throw new Error('offline'); } }),
                                 LiaTagStock.list().length]), [false, 4]);
ok('a link is found however its host is cased',
   await p.evaluate((u) => (LiaTagStock.find(u) || {}).tag_label, LINK('A').replace('docs.google.com', 'DOCS.Google.com')), 'FP161340');
ok('a printed number is found however it is typed',
   await p.evaluate(() => (LiaTagStock.find('fp-161341') || {}).tag_label), 'FP161341');
ok('a number is never matched against links, nor a link against numbers',
   await p.evaluate(() => [LiaTagStock.find('usp'), LiaTagStock.find('https://docs.google.com/x/FP161340')]), [null, null]);

// Seed the catalogue so the capture screen will start a job.
await p.evaluate(async () => {
  await LiaCache.status();
  const db = await new Promise(r => { const q = indexedDB.open('lia-field'); q.onsuccess = () => r(q.result); });
  await new Promise((res, rej) => {
    const t = db.transaction(['assets','meta'], 'readwrite');
    t.objectStore('assets').put({ asset_id:'a1', serial_key:'H1', serial_raw:'H-1', kind:'fall_protection',
      public_ref:'REF0000001', item_type:'Body harness', tag_label:'FP161282', tag_label_key:'FP161282' });
    t.objectStore('meta').put({ key:'sync', since:'2026-01-01T00:00:00Z', at:new Date().toISOString(), count:1 });
    t.oncomplete = () => { db.close(); res(); }; t.onerror = () => rej(t.error);
  });
});
await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);

// ── A single tap on a blank tag ─────────────────────────────────────────────
await p.evaluate((u) => fpLookup(undefined, ['04:11:22:33', null, u], { url: u, uid: '04:11:22:33', foreign: true }), LINK('A'));
await p.waitForTimeout(400);
ok('a blank tag is not treated as somebody else\'s link',
   await p.evaluate(() => $('fp-link-sheet').classList.contains('hidden')), true);
ok('and its sheet is not fetched', googleHits, 0);
ok('it opens a new item for the tech to fill in',
   await p.evaluate(() => ({ editing: $('fp-edit-form').style.display !== 'none', matched: _fpItem.matched })),
   { editing: true, matched: false });
ok('with the tag already on it: printed number and link',
   await p.evaluate(() => [_fpItem.tag_label, _fpItem.tag_url]), ['FP161340', LINK('A')]);
ok('and the chip id', await p.evaluate(() => _fpItem.nfc_tag_uid), '04:11:22:33');
ok('the serial box is left for the item\'s own serial, not the tag number',
   await p.evaluate(() => _fpItem.serial_raw), '');
ok('the tech is told what the tag is and what to do if the item has no serial',
   await p.$eval('#fp-hint', e => /FP161340 is one of your blank tags/.test(e.textContent) && /Use FP161340/.test(e.textContent)), true);

// Save it, and the tag leaves the phone's list.
await p.evaluate(() => { _fpItem.serial_raw = 'NEW-SN-1'; });
await p.selectOption('#fpf-equipment_type', await p.evaluate(() => LiaFpTypes.bySlug('climbing_belt') ? 'climbing_belt' : LiaFpTypes.all()[0].slug));
await p.waitForTimeout(150);
await p.click('#fp-btn-save'); await p.waitForTimeout(300);
const saved = await p.evaluate(() => _job.items[0]);
ok('the inspection keeps the link, which is how the server takes the tag out of stock',
   [saved.serial_num, saved.tag_url], ['NEW-SN-1', LINK('A')]);
ok('and the payload that goes up carries it',
   await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue')).pop().payload.tag_url), LINK('A'));
ok('the tag is off the phone\'s list at once', await p.evaluate(() => LiaTagStock.find('FP161340')), null);

// ── Typing the printed number ───────────────────────────────────────────────
await p.evaluate(() => fpLookup('fp161341'));
await p.waitForTimeout(300);
ok('typing a blank tag\'s number also starts a new item carrying it',
   await p.evaluate(() => [_fpItem.tag_label, _fpItem.tag_url, _fpItem.serial_raw]), ['FP161341', LINK('B'), '']);
ok('a number that is on an item still finds the item, not stock',
   await p.evaluate(async () => { fpLookup('FP161282'); await new Promise(r => setTimeout(r, 300)); return _fpItem.serial_raw; }), 'H-1');
await p.evaluate(() => { _fpItem = null; _fpChecks = []; fpRenderAll(); });

// ── Tap-through ─────────────────────────────────────────────────────────────
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
await p.evaluate((u) => window.__tap({ url: u, uid: 'AA:BB:CC:DD' }), LINK('C'));
await p.waitForTimeout(500);
ok('in a run, a blank tag stops it rather than passing anything',
   await p.evaluate(() => ({ batch: $('fp-batch-panel').style.display !== 'none', items: _job.items.length })),
   { batch: false, items: 1 });
ok('without reading its sheet or asking about a supplier',
   await p.evaluate(() => $('fp-link-sheet').classList.contains('hidden')), true);
ok('handing the tech a new item with the tag on it',
   await p.evaluate(() => [_fpItem.tag_label, _fpItem.tag_url, $('fp-edit-form').style.display !== 'none']),
   ['FP161342', LINK('C'), true]);
ok('still no request to Google', googleHits, 0);
await p.evaluate(() => { fpBatchStop(false); _fpItem = null; _fpChecks = []; _fpLink = null; fpRenderAll(); });
await p.waitForTimeout(150);

// ── A Google link that is NOT ours still takes the supplier path ────────────
await p.evaluate(() => fpLookup(undefined, [null, null, 'https://docs.google.com/spreadsheets/d/somebodyElse/edit'],
  { url: 'https://docs.google.com/spreadsheets/d/somebodyElse/edit', foreign: true }));
await p.waitForTimeout(500);
ok('a link not in stock is still somebody else\'s tag',
   await p.evaluate(() => !$('fp-link-sheet').classList.contains('hidden')), true);
await p.evaluate(() => { fpCloseLinkSheet(); _fpLink = null; _fpItem = null; fpRenderAll(); });

// ── Signing out ─────────────────────────────────────────────────────────────
ok('there is stock before signing out', await p.evaluate(() => LiaTagStock.list().length > 0), true);
await p.evaluate(() => LiaSync.signOut().catch(() => {}));
await p.waitForTimeout(200);
ok('signing out takes one company\'s tags off a shared phone',
   await p.evaluate(() => [LiaTagStock.list().length, localStorage.getItem(LiaTagStock.KEY)]), [0, null]);

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
