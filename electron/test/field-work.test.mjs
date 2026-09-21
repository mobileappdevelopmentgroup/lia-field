// Field Work, and the half of it called Work History.
//
// One list of every work order carrying field records. The point of the screen
// is the state on each row, and the point of the state is that it is DERIVED
// from the records rather than stored — a work order that was imported
// yesterday and gained three ladders this morning has to stop saying
// "processed" by itself, or those three go unbilled with nothing looking wrong.
//
// The state that earns its own colour is `needs_bsi_edit`: a record corrected
// AFTER it went to BSI. Re-running the import cannot repair it, because the
// importer only adds boxes BSI does not have. If the screen let that look like
// ordinary unprocessed work, a lead would re-import, see green, and believe a
// correction had landed that never did.
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

// What field_work_orders() returns, one of each state.
const LIVE = [
  { work_order_id: 'WO-NEW',   scope: 'ladder', total: 4, pushed: 0, stale: 0,
    processed_at: null, last_captured_at: '2026-09-20T16:00:00Z',
    archived_at: null, archived_by_name: null, techs: ['Ann'], state: 'needs_processing' },
  { work_order_id: 'WO-DONE',  scope: 'ladder', total: 3, pushed: 3, stale: 0,
    processed_at: '2026-09-19T12:00:00Z', last_captured_at: '2026-09-18T16:00:00Z',
    archived_at: null, archived_by_name: null, techs: ['Ann','Ben'], state: 'processed' },
  { work_order_id: 'WO-MORE',  scope: 'ladder', total: 5, pushed: 2, stale: 0,
    processed_at: '2026-09-19T12:00:00Z', last_captured_at: '2026-09-20T09:00:00Z',
    archived_at: null, archived_by_name: null, techs: ['Ben'], state: 'has_edits' },
  { work_order_id: 'WO-FIXED', scope: 'ladder', total: 2, pushed: 1, stale: 1,
    processed_at: '2026-09-17T12:00:00Z', last_captured_at: '2026-09-17T10:00:00Z',
    archived_at: null, archived_by_name: null, techs: ['Ann'], state: 'needs_bsi_edit' },
];
const FILED = [
  { work_order_id: 'WO-OLD', scope: 'ladder', total: 6, pushed: 6, stale: 0,
    processed_at: '2026-08-11T12:00:00Z', last_captured_at: '2026-08-10T16:00:00Z',
    archived_at: '2026-08-20T12:00:00Z', archived_by_name: 'Nate Dobbs',
    techs: ['Ann'], state: 'processed' },
];

const MERGE = { items: [
  { serialNum: 'A-1', winner: { clientId: 'i1', serialNum: 'A-1', scope: 'ladder',
      brand: 'Werner', type: 'Extension', length: '24', techName: 'Ann', parts: [] } },
  { serialNum: 'A-2', winner: { clientId: 'i2', serialNum: 'A-2', scope: 'ladder',
      brand: 'Louisville', type: 'Step', length: '6', techName: 'Ann', parts: [] } },
] };

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript((d) => {
  window.__calls = [];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    fieldList: async (archived) => {
      window.__calls.push({ fn: 'fieldList', archived });
      return { ok: true, workOrders: archived ? d.FILED : d.LIVE };
    },
    fieldSetArchived: async (p) => { window.__calls.push({ fn: 'fieldSetArchived', p }); return { ok: true }; },
    fieldAmend: async (p) => { window.__calls.push({ fn: 'fieldAmend', p }); return { ok: true }; },
    mergePull: async () => ({ ok: true, merge: d.MERGE, pulled: 2 }),
    mergeToCsv: async (p) => { window.__calls.push({ fn: 'mergeToCsv', p }); return { ok: true, path: '/tmp/x.csv', rows: 2 }; },
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
  };
}, { LIVE, FILED, MERGE });

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);

// ── The list, and what each row says ────────────────────────────────────────
await p.evaluate(() => { showScreen('field'); return loadFieldWork(false); });
await p.waitForTimeout(300);

ok('every work order with field records is listed',
   await p.$$eval('#field-wos .fw-row', e => e.length), 4);

const rowClass = (wo) => p.$$eval('#field-wos .fw-row', (els, w) => {
  const r = els.find(e => e.querySelector('.fw-wo').textContent === w);
  return r ? r.className : '';
}, wo);
const rowText = (wo) => p.$$eval('#field-wos .fw-row', (els, w) => {
  const r = els.find(e => e.querySelector('.fw-wo').textContent === w);
  return r ? r.textContent : '';
}, wo);

ok('work that is all in BSI is green', /\bprocessed\b/.test(await rowClass('WO-DONE')), true);
ok('and says when it went', /Processed 9\/1?9\/2026/.test(await rowText('WO-DONE')), true);

ok('work that has never been sent is neither green nor orange',
   await rowClass('WO-NEW'), 'fw-row needs_processing');
ok('and says so plainly', /Needs processing/.test(await rowText('WO-NEW')), true);

ok('a work order that gained records since the import is orange',
   /has_edits/.test(await rowClass('WO-MORE')), true);
ok('and counts what has not gone', /3 of 5 not sent/.test(await rowText('WO-MORE')), true);

// The one that matters most.
ok('a record corrected after it was pushed is its own state',
   /needs_bsi_edit/.test(await rowClass('WO-FIXED')), true);
ok('and is named as needing a fix in BSI, not another import',
   /Corrected after import/.test(await rowText('WO-FIXED')), true);

// ── Opening one ─────────────────────────────────────────────────────────────
await p.$$eval('#field-wos .fw-row', els =>
  els.find(e => e.querySelector('.fw-wo').textContent === 'WO-FIXED').click());
await p.waitForTimeout(400);

ok('the records are shown', await p.$$eval('#field-records .fw-rec', e => e.length), 2);
ok('the lead is told re-importing will not fix it',
   /will not change a box that is already there/i.test(await p.$eval('#field-head', e => e.textContent)), true);
ok('Field Work can import into BSI', await p.$$eval('#fw-import', e => e.length), 1);
ok('and can archive', await p.$$eval('#fw-archive', e => e.length), 1);
ok('every record can be corrected',
   await p.$$eval('#field-records button', e => e.length), 2);

// ── A correction has to say why ─────────────────────────────────────────────
await p.evaluate(() => { window.prompt = () => '   '; });
await p.click('#field-records button');
await p.waitForTimeout(200);
ok('a blank reason is refused',
   /needs a reason/i.test(await p.$eval('#field-msg', e => e.textContent)), true);
ok('and nothing was sent',
   await p.evaluate(() => window.__calls.filter(c => c.fn === 'fieldAmend').length), 0);

await p.evaluate(() => { let n = 0; window.prompt = () => (n++ === 0 ? 'wrong brand on the tag' : 'Werner'); });
await p.click('#field-records button');
await p.waitForTimeout(400);
ok('a correction with a reason goes through',
   await p.evaluate(() => window.__calls.filter(c => c.fn === 'fieldAmend').length), 1);
ok('carrying the reason to the server',
   await p.evaluate(() => window.__calls.find(c => c.fn === 'fieldAmend').p.reason), 'wrong brand on the tag');

// ── Archiving ───────────────────────────────────────────────────────────────
await p.$$eval('#field-wos .fw-row', els =>
  els.find(e => e.querySelector('.fw-wo').textContent === 'WO-DONE').click());
await p.waitForTimeout(400);
await p.click('#fw-archive');
await p.waitForTimeout(400);
ok('archiving is sent as archiving',
   await p.evaluate(() => { const c = window.__calls.filter(x => x.fn === 'fieldSetArchived').pop();
                            return [c.p.workOrderId, c.p.archived]; }), ['WO-DONE', true]);
ok('and the detail pane closes, since it left this list',
   await p.$eval('#field-detail', e => e.style.display), 'none');

// ── Work History is the same screen, read-only ──────────────────────────────
await p.evaluate(() => { showScreen('field'); return loadFieldWork(true); });
await p.waitForTimeout(300);
ok('Work History says so', await p.$eval('#field-title', e => e.textContent), 'Work History');
ok('and shows what was filed', await p.$$eval('#field-wos .fw-row', e => e.length), 1);

await p.click('#field-wos .fw-row');
await p.waitForTimeout(400);
ok('it says who filed it and when',
   /Filed .*by Nate Dobbs/.test(await p.$eval('#field-head', e => e.textContent)), true);
ok('there is NO import button — history is read-only',
   await p.$$eval('#fw-import', e => e.length), 0);
ok('and no way to correct a record here',
   await p.$$eval('#field-records button', e => e.length), 0);
ok('the one thing it can do is send the work order back',
   await p.$$eval('#fw-unarchive', e => e.length), 1);

await p.click('#fw-unarchive');
await p.waitForTimeout(400);
ok('which unarchives it',
   await p.evaluate(() => { const c = window.__calls.filter(x => x.fn === 'fieldSetArchived').pop();
                            return [c.p.workOrderId, c.p.archived]; }), ['WO-OLD', false]);

// Clicking a row in Work History must not quietly move you into Field Work.
await p.evaluate(() => { showScreen('field'); return loadFieldWork(true); });
await p.waitForTimeout(300);
await p.click('#field-wos .fw-row');
await p.waitForTimeout(300);
ok('opening a filed work order keeps you in Work History',
   await p.$eval('#field-title', e => e.textContent), 'Work History');

ok('no page errors', errs, []);

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll Field Work assertions passed.');
process.exit(fails ? 1 : 0);
