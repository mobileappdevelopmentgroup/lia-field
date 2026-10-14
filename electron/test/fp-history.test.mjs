// The Fall Protection History screen. Run with `npm run test:desktop`.
//
// What it must do before anything is sent: say which account the history goes
// into (the phones only see their own), show how every column was read and
// which rows will not go and why, and refuse to import a file with no pass/fail
// column until somebody says every row passed. The parse itself is the real
// one (electron/fp-history.cjs), run here on a real CSV.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const Papa = require('papaparse');
const { parseFpHistory } = require(path.join(ROOT, 'electron', 'fp-history.cjs'));
const parseCsv = csv => { const r = Papa.parse(csv, { header: true, skipEmptyLines: true }); return parseFpHistory(r.data, r.meta.fields); };

const WITH_RESULT = [
  'Serial Number,Date Inspected,Pass/Fail,Equipment Type,Mfr,Model,Mfr S/N,Inspected By,Colour',
  'BAT-1,03/12/2025,Pass,Full body harness,MSA,V-FORM,MSA-1,J. Ortiz,red',
  'BAT-2,03/12/2025,Fail,Rope grab,DBI,X,,J. Ortiz,blue',
  'BAT-3,03/12/2025,maybe,Lanyard,,,,J. Ortiz,',
].join('\n');
const NO_RESULT = ['Serial,Date', 'BAT-9,2025-01-02'].join('\n');

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

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('dialog', d => d.dismiss());

await p.addInitScript(([withResult, noResult]) => {
  window.__imports = [];
  window.__file = 'with-result';
  const parsed = { 'with-result': withResult, 'no-result': noResult };
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    getContext: async () => ({ ok: true, ctx: { role: 'lead', account_name: 'Nate Dobbs', impersonating: true } }),
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    openCsv: async () => '/Users/x/Desktop/' + window.__file + '.csv',
    fpHistoryParse: async () => parsed[window.__file],
    fpHistoryList: async () => ({ ok: true, batches: window.__imports.length
      ? [{ batch: window.__imports[0].batch, records: window.__imports[0].rows.length, first_date: '2025-03-12', last_date: '2025-03-12' }] : [] }),
    fpHistoryImport: async (payload) => { window.__imports.push(payload);
      return { ok: true, batch: payload.batch, imported: payload.rows.length, skipped: [], errors: [] }; },
  };
}, [parseCsv(WITH_RESULT), parseCsv(NO_RESULT)]);

await p.goto(BASE + '/index.html');
await p.waitForTimeout(500);
await p.click('#home-advanced'); await p.waitForTimeout(150);
ok('Fall Protection History is on the Advanced menu', await p.$eval('#adv-fphist', e => e.offsetParent !== null), true);
await p.click('#adv-fphist'); await p.waitForTimeout(400);
ok('it opens its own screen', await p.$eval('#screen-fphist', e => e.classList.contains('active')), true);
ok('it says which account the history goes into, and that it is the one being acted as',
   await p.$eval('#fphist-account', e => /Nate Dobbs/.test(e.textContent) && /acting as/.test(e.textContent)), true);

await p.click('#btn-fphist-pick'); await p.waitForTimeout(300);
ok('the preview opens', await p.$eval('#fphist-preview', e => e.style.display !== 'none'), true);
ok('two rows ready, one passed one failed, one that will not go',
   await p.$eval('#fphist-stat', e => e.textContent.replace(/\s+/g, ' ').trim()),
   '2 inspections ready — 1 passed, 1 failed · 1 row will not import');
ok('every column is shown as it was read',
   await p.$eval('#fphist-notes', e => /Serial Number → Serial \(assigned number\)/.test(e.textContent)
     && /Mfr S\/N → Manufacturer serial/.test(e.textContent)), true);
ok('a column nobody recognises is named', await p.$eval('#fphist-notes', e => /Not used:\s*Colour/.test(e.textContent)), true);
ok('the date reading is stated', await p.$eval('#fphist-notes', e => /month\/day\/year/.test(e.textContent)), true);
ok('a type Lia may not know is flagged', await p.$eval('#fphist-notes', e => /Rope grab \(1\)/.test(e.textContent)), true);
ok('and the row that will not go says why', await p.$eval('#fphist-notes', e => /Row 4 \(BAT-3\) — Result "maybe" is not pass or fail/.test(e.textContent)), true);
ok('no confirmation is asked when the file says pass or fail',
   await p.$eval('#fphist-confirm-row', e => e.style.display), 'none');

await p.click('#btn-fphist-import'); await p.waitForTimeout(300);
const sent = await p.evaluate(() => window.__imports[0]);
ok('the rows go up', sent.rows.map(r => [r.serial, r.inspection_date, r.result, r.equipment_type, r.mfr_serial]),
   [['BAT-1', '2025-03-12', 'pass', 'body_harness', 'MSA-1'], ['BAT-2', '2025-03-12', 'fail', 'Rope grab', null]]);
ok('under one batch named for the file', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} with-result$/.test(sent.batch), true);
ok('the result is reported', await p.$eval('#fphist-result-body', e => /2 inspections imported/.test(e.textContent)), true);
ok('and the batch is listed with an Undo', await p.$eval('#fphist-batches', e => /with-result/.test(e.textContent) && /Undo/.test(e.textContent)), true);

// A file with no pass/fail column.
await p.evaluate(() => { window.__file = 'no-result'; });
await p.click('#btn-fphist-pick'); await p.waitForTimeout(300);
ok('with no result column, the office is asked to confirm every row passed',
   await p.$eval('#fphist-confirm-row', e => e.style.display), 'flex');
await p.click('#btn-fphist-import'); await p.waitForTimeout(200);
ok('and nothing is sent until it does', await p.evaluate(() => window.__imports.length), 1);
await p.check('#fphist-all-passed');
await p.click('#btn-fphist-import'); await p.waitForTimeout(300);
ok('once ticked, the rows go up as passed', await p.evaluate(() => window.__imports[1].rows.map(r => r.result)), ['pass']);

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
