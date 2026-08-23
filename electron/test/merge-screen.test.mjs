// The merge review screen. What matters is that nothing is resolved without the
// lead seeing it. Run with `npm run test:desktop`.
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

// The renderer consumes whatever mergeRecords() produced, so run the real thing.
const { mergeRecords } = await import(path.join(ROOT, 'dist', 'lia-core.cjs'))
  .then(m => m.default || m);

const records = [
  { clientId:'1', serialNum:'A-1', scope:'ladder', techName:'Ann',
    capturedAt:'2026-08-01T10:00:00Z', brand:'Werner', length:'24' },
  // Ben disagrees with Ann about the length.
  { clientId:'2', serialNum:'A-1', scope:'ladder', techName:'Ben',
    capturedAt:'2026-08-01T15:00:00Z', brand:'Werner', length:'28' },
  { clientId:'3', serialNum:'A-2', scope:'ladder', techName:'Ann',
    capturedAt:'2026-08-01T11:00:00Z', brand:'Louisville', length:'6' },
  // Cal failed an item Dee later passed.
  { clientId:'4', serialNum:'H-9', scope:'fall_protection', techName:'Cal',
    capturedAt:'2026-08-01T09:00:00Z', overallPass:false, manufacturer:'MSA', model:'V-FIT' },
  { clientId:'5', serialNum:'H-9', scope:'fall_protection', techName:'Dee',
    capturedAt:'2026-08-01T16:00:00Z', overallPass:true, manufacturer:'MSA', model:'V-FIT' },
  // Deleted after upload.
  { clientId:'6', serialNum:'A-3', scope:'ladder', techName:'Ann',
    capturedAt:'2026-08-01T12:00:00Z' },
  { clientId:'7', serialNum:'A-3', scope:'ladder', techName:'Ann',
    capturedAt:'2026-08-01T13:00:00Z', deleted:true },
  // A phone whose clock is 45 minutes out.
  { clientId:'8', serialNum:'A-4', scope:'ladder', techName:'Ann', capturedAt:'2026-08-01T10:00:00Z' },
  { clientId:'9', serialNum:'A-4', scope:'ladder', techName:'Ben',
    capturedAt:'2026-08-01T14:00:00Z', clockSkewMs: 45*60*1000 },
];
const merge = mergeRecords(records);

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript((m) => {
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [
      { workOrderId: 'WO-8810', items: 5, lastCapturedAt: '2026-08-01T16:00:00Z',
        techs: [{ name: 'Ann', role: 'lead', items: 3 }, { name: 'Ben', role: 'tech', items: 2 }] },
    ]}),
    mergePull: async () => ({ ok: true, merge: m, pulled: 9 }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
  };
}, merge);

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);
await p.evaluate(() => { showScreen('merge'); loadMerge(); });
await p.waitForTimeout(300);

ok('work orders with field work are listed', await p.$$eval('#merge-wos .cat-item', e => e.length), 1);
await p.click('#merge-wos .cat-item');
await p.waitForTimeout(400);

ok('every tech who contributed is named', await p.$$eval('.mg-tech', e => e.length), 4);
// A-1, A-2, H-9, A-4 — A-3 was deleted.
ok('the merged set is shown', await p.$$eval('.mg-item', e => e.length), 4);
ok('and counted', await p.$eval('#merge-count', e => e.textContent), '4 items');

const warnings = await p.$eval('#merge-warnings', e => e.textContent);
ok('disagreements are surfaced, not resolved quietly', /disagree on/.test(warnings), true);
ok('a deleted item is accounted for rather than vanishing', /deleted by a tech/.test(warnings), true);
ok('and named so the lead can check it', /A-3/.test(warnings), true);
ok('a badly skewed clock is called out', /device clock is well out/.test(warnings), true);
ok('and the FAIL override is explained', /FAIL stands/.test(warnings), true);

ok('the conflicted item is marked', await p.$$eval('.mg-item.conflict', e => e.length), 1);
// Newest first, so the preselected default is the most recent capture.
ok('with both values and both names',
   await p.$$eval('.mg-item.conflict .mg-opt', e => e.map(x => x.textContent)),
   ['Ben: 28', 'Ann: 24']);
// A pass/fail disagreement is reported, never offered as something to pick.
ok('the overall result is not a selectable option',
   await p.$$eval('.mg-opt', e => e.every(x => !/true|false/.test(x.textContent))), true);
ok('the newest is preselected, not chosen for good',
   await p.$eval('.mg-item.conflict .mg-opt', e => e.classList.contains('sel')), true);

// The lead can overrule the default.
await p.click('.mg-item.conflict .mg-opt:nth-child(2)');
await p.waitForTimeout(250);
ok('and the lead can pick the other one',
   await p.$$eval('.mg-item.conflict .mg-opt', e => e.map(x => x.classList.contains('sel'))), [false, true]);

// Safety outranks recency, and it must be visible on the row itself.
const fpRow = await p.$$eval('.mg-item', els => {
  const el = els.find(e => e.textContent.includes('H-9'));
  return { removed: /REMOVED/.test(el.textContent), explained: /FAIL is kept/.test(el.textContent) };
});
ok('the condemned item stays condemned', fpRow.removed, true);
ok('and says why it beat the later pass', fpRow.explained, true);

console.log('\npage errors:', errs.length ? errs : 'none');
await b.close(); server.close();
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
process.exit(fails || errs.length ? 1 : 0);
