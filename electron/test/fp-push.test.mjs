// Pushing fall protection onto a BSI work order. Run with `npm run test:desktop`.
//
// This is the screen that bills a customer, so the tests are about the two ways
// it can cost somebody money:
//   • pushing something that was already pushed (a double invoice line)
//   • losing track of what landed when the run dies halfway
// and about the third way it can go wrong quietly — a run that partly failed
// but reads as a success.
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

const PENDING = [
  { inspection_id: 'i1', work_order_id: 'WO-100', serial_num: 'H-1',
    item_type: 'Body harness', inspection_date: '2026-08-01', overall_pass: true },
  { inspection_id: 'i2', work_order_id: 'WO-100', serial_num: 'H-2',
    item_type: 'Lanyard', inspection_date: '2026-08-01', overall_pass: false },
  { inspection_id: 'i3', work_order_id: 'WO-200', serial_num: 'H-3',
    item_type: 'SRL', inspection_date: '2026-08-02', overall_pass: true },
];

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(({ pending }) => {
  window.__calls = [];
  window.__handlers = {};
  const bind = (name) => (cb) => { window.__handlers[name] = cb; };
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    fprList: async () => ({ ok: true, result: { rows: [], total: 0 } }),
    fprDetail: async () => ({ ok: true, detail: { asset: {}, history: [], claims: [], audit: [] } }),
    fprPendingBsi: async () => { window.__calls.push(['pending']); return { ok: true, pending: window.__pending }; },
    fpPushStart: (items) => window.__calls.push(['start', items]),
    fpPushReady: () => window.__calls.push(['ready']),
    fpPushStop: () => window.__calls.push(['stop']),
    onFpPushLog: bind('log'), onFpPushWaiting: bind('waiting'), onFpPushPushed: bind('pushed'),
    onFpPushComplete: bind('complete'), onFpPushError: bind('error'), onFpPushExited: bind('exited'),
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
  };
  window.__pending = pending;
}, { pending: PENDING });

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);
// FP Records lost its home card when Merge Field Work and FP Records became
// one Field Work screen. The screen itself is unchanged and still reachable.
await p.evaluate(() => { showScreen('fpr'); loadFpr(); }); await p.waitForTimeout(300);
await p.click('#btn-fpr-push'); await p.waitForTimeout(400);

ok('the push screen opens', await p.evaluate(() => $('screen-fppush').classList.contains('active')), true);
ok('waiting work is grouped by work order', await p.$$eval('.fpp-wo', e => e.length), 2);
ok('and each item is listed', await p.$$eval('.fpp-item', e => e.length), 3);
// A failed inspection is a removal, which is a different BSI line and a
// different amount. Billing it as an inspection is a wrong invoice.
ok('a removal is called out as one, not billed as an inspection',
   await p.$$eval('.fpp-rm', e => e.map(x => x.textContent.trim())), ['REMOVAL']);

// The operator holds back one item.
await p.click('[data-fpp-id="i2"]'); await p.waitForTimeout(150);
ok('unticking an item shows in the work order count',
   await p.$$eval('.fpp-wo .fpp-n', e => e.map(x => x.textContent.trim())), ['1 of 2', '1 of 1']);

await p.click('#btn-fpp-start'); await p.waitForTimeout(250);
ok('only the ticked items are sent',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'start').pop()[1].map(i => i.inspection_id)),
   ['i1', 'i3']);
ok('and the screen shows it is running',
   await p.evaluate(() => $('btn-fpp-start').disabled && $('btn-fpp-stop').style.display !== 'none'), true);

// Nothing may be typed until a human confirms the right work order is open —
// there is nothing on the BSI page that says which one it is.
await p.evaluate(() => window.__handlers.waiting());
await p.waitForTimeout(120);
ok('the run stops and asks before touching a work order',
   await p.evaluate(() => $('fpp-wait').style.display !== 'none'), true);
ok('and nothing was confirmed on its own',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'ready').length), 0);
await p.click('#btn-fpp-continue'); await p.waitForTimeout(150);
ok('confirming releases it', await p.evaluate(() => window.__calls.filter(c => c[0] === 'ready').length), 1);

// THE property: a landed box leaves the waiting list the moment it lands, so
// what is on screen is what is genuinely still to do.
await p.evaluate(() => window.__handlers.pushed({ inspectionId: 'i1', serialNum: 'H-1', boxRef: 'box-4' }));
await p.waitForTimeout(150);
ok('a box that has landed leaves the waiting list at once',
   await p.$$eval('.fpp-item [data-fpp-id]', e => e.map(x => x.dataset.fppId)), ['i2', 'i3']);
ok('and the count says so', await p.$eval('#fpp-msg', e => e.textContent.trim()), '1 added so far.');

await p.evaluate(() => window.__handlers.log('  [1/2] H-1'));
await p.waitForTimeout(100);
ok('the log is shown', await p.$eval('#fpp-log', e => /H-1/.test(e.textContent)), true);

// A partly-failed run must not read as a clean one.
await p.evaluate(() => window.__handlers.complete({
  success: false,
  totals: { pushed: 1, skipped: 1, failed: 1 },
  workOrders: [
    { workOrderId: 'WO-100',
      // Fall protection is ONE box carrying quantities, so what was billed has
      // to be shown by code — otherwise the operator has a box and no way to
      // check it against what the techs actually recorded.
      lines: [{ code: 'FP1', description: 'BODY HARNESS INSPECTION', quantity: 3 }],
      pushed: [{ inspectionId: 'i1', serialNum: 'H-1', boxRef: 'box-4' }],
      skipped: [{ inspection_id: 'i2', serial_num: 'C-9',
                  reason: 'Crane lift sling has no billing code — inspected, not invoiced' }],
      failed: [] },
    { workOrderId: 'WO-200', lines: [],
      pushed: [], skipped: [],
      failed: [{ inspectionId: '', serialNum: '',
                 error: 'No BSI work order window was open, so nothing was entered.' }] },
  ],
}));
await p.waitForTimeout(250);
const done = await p.$eval('#fpp-done', e => e.textContent);
ok('a run with problems does not report as finished cleanly', /finished with problems/.test(done), true);
ok('what went on the invoice is shown by code', /FP1 × 3\s+BODY HARNESS INSPECTION/.test(done), true);
// A failure that is not explained gets retried blindly until somebody gives up.
ok('a work order that took nothing says why', /nothing was entered/.test(done), true);
// Six of the fourteen equipment types have no code yet, so this is a normal
// outcome and the item has to be named rather than quietly missing.
ok('an item with no billing code is named, not dropped',
   /C-9: Crane lift sling has no billing code/.test(done), true);
ok('and is described as inspected rather than failed',
   /inspected, not invoiced/.test(done), true);
ok('the screen is no longer running',
   await p.evaluate(() => !$('btn-fpp-start').disabled || $('btn-fpp-stop').style.display === 'none'), true);

// Work order ids and serials are free text and go into innerHTML.
ok('a work order containing markup is escaped, not rendered',
   await p.evaluate(() => {
     _fppPending = [{ inspection_id: 'x', work_order_id: '<img src=x onerror=alert(1)>',
                      serial_num: '<b>S</b>', overall_pass: true }];
     _fppSkip = new Set();
     renderFppPending();
     return { imgs: document.querySelectorAll('#fpp-pending img').length,
              bolds: document.querySelectorAll('#fpp-pending .fpp-sn b').length,
              text: document.querySelector('.fpp-sn').textContent };
   }), { imgs: 0, bolds: 0, text: '<b>S</b>' });

// Nothing left to do must say so plainly, and must not offer to start a run.
ok('an empty queue is stated, and cannot be started',
   await p.evaluate(() => {
     _fppPending = []; renderFppPending();
     return { said: /already been pushed/.test($('fpp-pending').textContent),
              disabled: $('btn-fpp-start').disabled };
   }), { said: true, disabled: true });

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
