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
import { createRequire } from 'module';
const { groupVersions } = createRequire(import.meta.url)('../field-versions.cjs');

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

// Every version of what is on WO-FIXED: A-1 collected, pushed, then corrected;
// A-2 untouched; A-3 deleted. Built by the same grouping main uses.
const LROW = (o) => Object.assign({ asset_id: 'x', serial_num: 'A-1', inspection_date: '2026-09-17',
  version: 1, is_current: true, is_deleted: false, source: 'field', captured_at: '2026-09-17T10:00:00Z',
  created_at: '2026-09-17T10:05:00Z', bsi_pushed_at: null, collector_name: 'Ann', brand: 'Werner',
  type: 'Extension', length: '24', notes: null, work_order_id: 'WO-FIXED', parts: [{ name: 'G13', qty: 2 }],
  lubricated: null, has_leveler: null, has_claw: null, has_vrung: null }, o);
const ITEMS = groupVersions({
  ladders: [
    LROW({ id: '00000000-0000-0000-0000-0000000000a1', is_current: false, bsi_pushed_at: '2026-09-17T12:00:00Z' }),
    LROW({ id: '00000000-0000-0000-0000-0000000000a2', version: 2, source: 'office_amend', brand: 'Louisville' }),
    LROW({ id: '00000000-0000-0000-0000-0000000000b1', asset_id: 'y', serial_num: 'A-2', brand: 'Louisville', type: 'Step', length: '6', parts: [] }),
    LROW({ id: '00000000-0000-0000-0000-0000000000c1', asset_id: 'z', serial_num: 'A-3', is_current: false, is_deleted: true }),
  ],
  audits: [{ scope: 'ladder', inspection_id: '00000000-0000-0000-0000-0000000000a2', action: 'amend',
             reason: 'wrong brand on the tag', actor_name: 'Nate Dobbs', created_at: '2026-09-18T09:00:00Z' }],
});

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
    fieldDelete: async (p) => { window.__calls.push({ fn: 'fieldDelete', p }); return { ok: true }; },
    fieldDeleteItem: async (p) => { window.__calls.push({ fn: 'fieldDeleteItem', p }); return { ok: true }; },
    fieldRestore: async (p) => { window.__calls.push({ fn: 'fieldRestore', p }); return { ok: true }; },
    fieldAdd: async (p) => { window.__calls.push({ fn: 'fieldAdd', p }); return { ok: true }; },
    fieldHistory: async () => ({ ok: true, items: d.ITEMS }),
    mergePull: async () => ({ ok: true, merge: d.MERGE, pulled: 2 }),
    mergeToCsv: async (p) => { window.__calls.push({ fn: 'mergeToCsv', p }); return { ok: true, path: '/tmp/x.csv', rows: 2 }; },
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
  };
}, { LIVE, FILED, MERGE, ITEMS });

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

ok('every item is shown, the deleted one too', await p.$$eval('#field-records .fw-rec', e => e.length), 3);
ok('the lead is told re-importing will not fix it',
   /will not change a box that is already there/i.test(await p.$eval('#field-head', e => e.textContent)), true);
ok('Field Work can import into BSI', await p.$$eval('#fw-import', e => e.length), 1);
ok('and can archive', await p.$$eval('#fw-archive', e => e.length), 1);

const recRow = (ser) => `#field-records .fw-rec:has(.fw-rec-ser:text-matches("^${ser}\\\\b"))`;
const rowAct = (ser, act) => `${recRow(ser)} [data-act="${act}"]`;
ok('a live item can be edited and deleted',
   [await p.$$eval(rowAct('A-2', 'edit'), e => e.length), await p.$$eval(rowAct('A-2', 'delete'), e => e.length)], [1, 1]);
ok('a correction made after BSI is named as one',
   /Changed after BSI/.test(await p.$eval(recRow('A-1'), e => e.textContent)), true);
ok('and can be undone', await p.$$eval(rowAct('A-1', 'undo'), e => e.length), 1);
ok('a field record has no correction to undo', await p.$$eval(rowAct('A-2', 'undo'), e => e.length), 0);
ok('a deleted item offers Restore, not Edit',
   [await p.$$eval(rowAct('A-3', 'restore'), e => e.length), await p.$$eval(rowAct('A-3', 'edit'), e => e.length)], [1, 0]);

// ── History: what the field collected, what changed, what went to BSI ───────
await p.click(rowAct('A-1', 'history'));
await p.waitForTimeout(150);
const hist = await p.$eval(`${recRow('A-1')} .fw-rec-more`, e => e.textContent);
ok('history shows the field version', /v1 · Collected in the field/.test(hist), true);
ok('and the office correction', /v2 · Corrected in the office · CURRENT/.test(hist), true);
ok('with what changed', /Brand:\s*Werner → Louisville/.test(hist), true);
ok('why, and who', /Corrected by Nate Dobbs .*wrong brand on the tag/.test(hist), true);
ok('and which version reached BSI', /Sent to BSI/.test(hist) && /Not sent to BSI/.test(hist), true);

// ── Editing: no prompt(), an inline form ────────────────────────────────────
await p.evaluate(() => { window.prompt = () => { throw new Error('prompt() is and will not be supported.'); }; });
await p.click(rowAct('A-2', 'edit'));
await p.waitForTimeout(150);
const form = `${recRow('A-2')} .fw-rec-more`;
ok('Edit opens a form in the row', await p.$$eval(`${form} [data-k="brand"]`, e => e.length), 1);
ok('the note is labelled optional', /Note \(optional\)/.test(await p.$eval(form, e => e.textContent)), true);
await p.click(`${form} .fw-save`);
await p.waitForTimeout(150);
ok('saving with nothing changed is refused', /Nothing was changed/i.test(await p.$eval('#field-msg', e => e.textContent)), true);
ok('and nothing was sent', await p.evaluate(() => window.__calls.filter(c => c.fn === 'fieldAmend').length), 0);

// No note: the office is not made to justify fixing a typo. Main fills the
// server's required reason in (officeNote); the screen just sends it blank.
await p.fill(`${form} [data-k="brand"]`, 'Werner');
await p.fill(`${form} [data-k="parts"]`, 'W44 x2');
await p.selectOption(`${form} [data-k="has_claw"]`, 'yes');
await p.click(`${form} .fw-save`);
await p.waitForTimeout(400);
const amend = await p.evaluate(() => window.__calls.find(c => c.fn === 'fieldAmend'));
ok('a correction with no note goes through', !!amend, true);
ok('with the note blank', amend && amend.p.reason, '');
ok('and only what changed', amend && amend.p.fields, { brand: 'Werner', parts: 'W44 x2', has_claw: true });
ok('the placeholder for a blank note is not quoted in History',
   await p.evaluate(() => [hasNote('(no note)'), hasNote(''), hasNote('wrong brand')]), [false, false, true]);

// ── Delete, undo, restore ───────────────────────────────────────────────────
await p.click(rowAct('A-1', 'delete'));
await p.waitForTimeout(150);
ok('deleting asks for no reason', await p.$$eval(`${recRow('A-1')} .fw-reason`, e => e.length), 0);
await p.click(`${recRow('A-1')} .fw-save`);
await p.waitForTimeout(400);
const di = await p.evaluate(() => window.__calls.find(c => c.fn === 'fieldDeleteItem'));
ok('deleting an item takes every live version, newest first',
   di && di.p.ids, ['00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1']);

await p.click(rowAct('A-1', 'undo'));
await p.waitForTimeout(150);
await p.click(`${recRow('A-1')} .fw-save`);
await p.waitForTimeout(400);
ok('undo deletes only the correction',
   await p.evaluate(() => (window.__calls.find(c => c.fn === 'fieldDelete') || {}).p.inspectionId), '00000000-0000-0000-0000-0000000000a2');

await p.click(rowAct('A-3', 'restore'));
await p.waitForTimeout(150);
await p.click(`${recRow('A-3')} .fw-save`);
await p.waitForTimeout(400);
ok('restore brings back the deleted version',
   await p.evaluate(() => (window.__calls.find(c => c.fn === 'fieldRestore') || {}).p.inspectionId), '00000000-0000-0000-0000-0000000000c1');

// ── Adding a ladder the field never sent ────────────────────────────────────
ok('Field Work can add a ladder', await p.isVisible('#fw-add-btn'), true);
await p.click('#fw-add-btn');
await p.click('#fwa-save');
await p.waitForTimeout(150);
ok('an add needs a serial', await p.evaluate(() => window.__calls.filter(c => c.fn === 'fieldAdd').length), 0);
await p.fill('#fwa-serial', 'A-9');
await p.fill('#fwa-brand', 'Werner');
await p.fill('#fwa-parts', 'G13 x2');
await p.click('#fwa-save');
await p.waitForTimeout(400);
const add = await p.evaluate(() => window.__calls.find(c => c.fn === 'fieldAdd'));
ok('the add goes to this work order', add && [add.p.workOrderId, add.p.serialNum, add.p.reason],
   ['WO-FIXED', 'A-9', '']);

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
ok('and no way to change a record here',
   await p.$$eval('#field-records [data-act="edit"], #field-records [data-act="delete"], #field-records [data-act="restore"]', e => e.length), 0);
ok('but the history can still be read',
   (await p.$$eval('#field-records [data-act="history"]', e => e.length)) > 0, true);
ok('and nothing can be added', await p.isVisible('#fw-add-btn'), false);
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
