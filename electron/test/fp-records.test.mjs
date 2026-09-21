// The fall protection records screen. Run with `npm run test:desktop`.
//
// These are safety documents, so the screen is judged on what it makes visible
// and what it refuses to do quietly:
//   • superseded and deleted records are SHOWN, marked — an audit trail that
//     hides what changed is not one
//   • neither correcting nor deleting is possible without a typed reason
//   • the tech's answers are not editable here; changing what was found is
//     re-inspecting, not amending
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
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

const ROWS = [
  { asset_id: 'a1', serial_raw: 'FP158354', public_ref: 'B7K2M9QRXZ', nfc_tag_uid: '04A1B2C3',
    tag_url: 'https://acme.example/tag/FP158354', tag_label: 'FP158354', inspection_id: 'i2',
    inspection_date: '2026-08-01', next_due_date: '2027-08-01', item_type: 'Body harness',
    manufacturer: 'MSA Safety', model: 'V-FIT', overall_pass: true,
    effective_status: 'pass', history_count: 3 },
  { asset_id: 'a2', serial_raw: 'FP900', inspection_date: '2024-01-02',
    next_due_date: '2025-01-02', item_type: 'Lanyard', overall_pass: false,
    effective_status: 'fail', history_count: 1 },
];

const DETAIL = {
  asset: { id: 'a1', serial_raw: 'FP158354', public_ref: 'B7K2M9QRXZ',
           nfc_tag_uid: '04A1B2C3', tag_label: 'FP158354',
           tag_url: 'https://acme.example/tag/FP158354' },
  history: [
    { id: 'i2', inspection_date: '2026-08-01', manufacturer: 'MSA Safety', model: 'V-FIT',
      overall_pass: true, version: 2, is_current: true, is_deleted: false,
      collector_name: 'Alex', work_order_id: 'WO-888', source: 'office_amend', checks: [] },
    { id: 'i1', inspection_date: '2026-08-01', manufacturer: 'MSA', model: 'V-FIT',
      overall_pass: true, version: 1, is_current: false, is_deleted: false,
      collector_name: 'Alex', work_order_id: 'WO-888', source: 'field', checks: [] },
    { id: 'i0', inspection_date: '2025-08-01', manufacturer: 'MSA', model: 'V-FIT',
      overall_pass: true, version: 1, is_current: false, is_deleted: true,
      collector_name: 'Alex', source: 'field', checks: [] },
  ],
  claims: [
    { source_url: 'https://docs.google.com/spreadsheets/d/S/htmlview',
      claimed_inspection_date: '2026-08-22', claimed_pass: true, claimed: {},
      created_at: '2026-08-22T10:00:00Z' },
  ],
  audit: [
    { action: 'amend', reason: 'Manufacturer was abbreviated on the phone',
      actor_name: 'Nate', created_at: '2026-08-20T12:00:00Z' },
  ],
};

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(({ rows, detail }) => {
  window.__calls = [];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    fprList: async (o) => { window.__calls.push(['list', o]); return { ok: true, result: { rows, total: rows.length } }; },
    fprDetail: async (id) => { window.__calls.push(['detail', id]); return { ok: true, detail }; },
    fprAmend: async (p2) => { window.__calls.push(['amend', p2]); return { ok: true, result: {} }; },
    fprDelete: async (p2) => { window.__calls.push(['delete', p2]); return { ok: true, result: {} }; },
    fprRestore: async (p2) => { window.__calls.push(['restore', p2]); return { ok: true, result: {} }; },
    fprUpdateAsset: async (p2) => { window.__calls.push(['asset', p2]); return { ok: true, result: {} }; },
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
  };
}, { rows: ROWS, detail: DETAIL });

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);
// FP Records lost its home card when Merge Field Work and FP Records became
// one Field Work screen. The screen itself is unchanged and still reachable.
await p.evaluate(() => { showScreen('fpr'); loadFpr(); }); await p.waitForTimeout(400);

ok('the records screen opens', await p.evaluate(() => $('screen-fpr').classList.contains('active')), true);
ok('items are listed', await p.$$eval('#fpr-list .sup-item', e => e.length), 2);
ok('a removed item is marked as such',
   await p.$$eval('#fpr-list .fpr-st', e => e.map(x => x.textContent.trim())), ['Pass', 'Removed']);

// The office is holding an item and does not know which identifier it has, so
// one box searches all of them — server side.
await p.fill('#fpr-search', 'V-FIT'); await p.waitForTimeout(450);
ok('search is passed to the server rather than filtered locally',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'list').pop()[1].search), 'V-FIT');
await p.fill('#fpr-search', ''); await p.waitForTimeout(450);

await p.click('#fpr-list .sup-item'); await p.waitForTimeout(400);
ok('opening an item asks for its detail',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'detail').pop()[1]), 'a1');

// THE property. All three versions are on screen, each labelled.
ok('every version is shown, superseded and deleted included',
   await p.$$eval('.fpr-hist', e => e.length), 3);
// The version number only appears once there is more than one, so a record
// nobody has touched does not read as though it had been revised.
ok('and each says which it is, with the revision number where there is one',
   await p.$$eval('.fpr-hist-state', e => e.map(x => x.textContent.trim())),
   ['current · v2', 'superseded', 'deleted']);
ok('a deleted record offers Restore rather than Correct',
   await p.$$eval('.fpr-hist.deleted .fpr-mini', e => e.map(x => x.textContent.trim())), ['Restore']);
// Why it changed, and who changed it.
ok('the corrections trail is shown',
   await p.$eval('#fpr-detail', e => /Manufacturer was abbreviated/.test(e.textContent)), true);
ok('with who made it',
   await p.$eval('#fpr-detail', e => /Nate/.test(e.textContent)), true);
// What a third-party tag claimed, kept visibly apart from the real record.
ok('tag-link claims are shown separately and marked as not inspections',
   await p.$eval('#fpr-detail', e => /Never counted as an inspection/.test(e.textContent)), true);

// ── Correcting ──────────────────────────────────────────────────────────────
await p.click('[data-fpr-amend]'); await p.waitForTimeout(250);
ok('correcting opens a form', await p.evaluate(() => !!$('fpi-reason')), true);
// Changing what was FOUND is re-inspecting, not amending, and the screen says so.
ok('and says the tech’s answers are not editable here',
   await p.$eval('.fpr-inline', e => /Changing what\s+was found is re-inspecting/.test(e.textContent.replace(/\s+/g, ' '))), true);

await p.click('#fpi-save'); await p.waitForTimeout(250);
// A correction with no reason is indistinguishable from tampering later on.
ok('a correction with no reason is refused',
   await p.$eval('#fpr-msg', e => /reason is required/i.test(e.textContent)), true);
ok('and nothing was sent', await p.evaluate(() => window.__calls.filter(c => c[0] === 'amend').length), 0);

await p.fill('#fpi-mfr', 'MSA Safety Works');
await p.fill('#fpi-reason', 'Model was recorded from the wrong label');
await p.click('#fpi-save'); await p.waitForTimeout(400);
ok('a correction with a reason goes through',
   await p.evaluate(() => {
     const c = window.__calls.filter(x => x[0] === 'amend').pop()[1];
     return { id: c.inspection_id, mfr: c.manufacturer, reason: c.reason };
   }),
   { id: 'i2', mfr: 'MSA Safety Works', reason: 'Model was recorded from the wrong label' });
ok('and the lead is told the old version is kept',
   await p.$eval('#fpr-msg', e => /previous version is kept/i.test(e.textContent)), true);

// ── Deleting ────────────────────────────────────────────────────────────────
await p.click('[data-fpr-del]'); await p.waitForTimeout(250);
await p.click('#fpi-save'); await p.waitForTimeout(250);
ok('a deletion with no reason is refused',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'delete').length), 0);
await p.fill('#fpi-reason', 'Recorded against the wrong item');
await p.click('#fpi-save'); await p.waitForTimeout(400);
ok('a deletion with a reason goes through',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'delete').pop()[1]),
   { inspection_id: 'i2', reason: 'Recorded against the wrong item' });
// It is not destroyed, and the wording has to say so or the lead will not use it.
ok('and the lead is told the record is kept',
   await p.$eval('#fpr-msg', e => /kept and stays auditable/i.test(e.textContent)), true);

// ── Correcting the item itself ──────────────────────────────────────────────
await p.click('#btn-fpr-edit-asset'); await p.waitForTimeout(200);
await p.fill('#fpa-serial', 'FP158354A');
await p.click('#btn-fpa-save'); await p.waitForTimeout(250);
ok('changing a serial without a reason is refused',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'asset').length), 0);
await p.fill('#fpa-reason', 'Serial was mistyped on first entry');
await p.click('#btn-fpa-save'); await p.waitForTimeout(400);
ok('with a reason it goes through',
   await p.evaluate(() => {
     const c = window.__calls.filter(x => x[0] === 'asset').pop()[1];
     return { serial: c.serial_raw, reason: c.reason };
   }), { serial: 'FP158354A', reason: 'Serial was mistyped on first entry' });
// Tags already in the field point at the certificate code.
ok('and the certificate code is explicitly out of scope',
   await p.$eval('#fpr-detail', e => /certificate code never changes/i.test(e.textContent)), true);

// The label printed on the tag is a second identifier, not the serial. Somebody
// ringing up is reading one of the two and rarely says which, so both are on
// screen and both are correctable.
ok('the label printed on the tag is listed beside the serial',
   await p.$$eval('#fpr-list .fpr-lbl', e => e.map(x => x.textContent.trim())), ['FP158354']);
ok('and shown on the item itself',
   await p.$eval('#fpr-detail', e => /Label FP158354/.test(e.textContent)), true);

await p.click('#btn-fpr-edit-asset'); await p.waitForTimeout(200);
await p.fill('#fpa-label', 'FP999999');
await p.fill('#fpa-reason', 'Label was read off the wrong tag');
await p.click('#btn-fpa-save'); await p.waitForTimeout(300);
ok('a corrected label is sent with its reason',
   await p.evaluate(() => {
     const c = window.__calls.filter(x => x[0] === 'asset').pop()[1];
     return { label: c.tag_label, reason: c.reason };
   }), { label: 'FP999999', reason: 'Label was read off the wrong tag' });

// Serials and models are free text from the field and go into innerHTML.
ok('a serial containing markup is escaped, not rendered',
   await p.evaluate(() => {
     _fprRows = [{ asset_id: 'x', serial_raw: '<img src=x onerror=alert(1)>',
                   effective_status: 'pass', history_count: 0 }];
     renderFprList();
     return { imgs: document.querySelectorAll('#fpr-list img').length,
              text: document.querySelector('.fpr-sn').textContent };
   }), { imgs: 0, text: '<img src=x onerror=alert(1)>' });

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
