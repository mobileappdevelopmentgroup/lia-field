// Fall protection catalogue screen. Loads the real renderer with a stubbed
// window.api, so the screen's own logic is under test rather than IPC.
// Run with `npm run test:desktop`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
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
  const models = [
    { id: 'm1', manufacturer: 'MSA', model: 'V-FIT', item_type: 'Harness', has_impact_indicator: true },
    { id: 'm2', manufacturer: 'Petzl', model: 'AVAO', item_type: 'Harness', has_impact_indicator: false },
  ];
  window.__published = [];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com', name: 'Lead' }, credits: 5 }),
    fpListModels: async () => ({ ok: true, models }),
    fpGetChecks: async (id) => id === 'm1'
      ? { ok: true, version: 3, published: true, checks: [
          { ord: 0, code: 'labels', prompt: 'Labels legible' },
          { ord: 1, code: 'webbing', prompt: 'Webbing intact' }] }
      : { ok: true, version: 0, published: false, checks: [] },
    fpSaveModel: async (m) => { if (!m.id) { m.id = 'm3'; models.push(m); } return { ok: true, id: m.id }; },
    fpPublishChecks: async (id, checks) => { window.__published.push({ id, checks }); return { ok: true, version: 4 }; },
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
  };
});
await p.goto(BASE + '/index.html');
await p.waitForTimeout(500);
await p.evaluate(() => { showScreen('catalog'); loadCatalog(); });
await p.waitForTimeout(400);

ok('the catalogue lists the account models', await p.$$eval('.cat-item', e => e.length), 2);
ok('showScreen reaches a screen it was never told about',
   await p.$eval('#screen-catalog', e => e.classList.contains('active')), true);

await p.click('.cat-item:nth-child(1)');
await p.waitForTimeout(300);
ok('selecting a model loads its checks', await p.$$eval('.cat-check-row input', e => e.length), 2);
ok('and shows which version is live', await p.$eval('#cat-version', e => e.textContent), 'v3 · published');
ok('the indicator flag round-trips', await p.$eval('#cat-indicator', e => e.checked), true);
ok('and the indicator check is not authored by hand',
   await p.$eval('#cat-checks', e => /added automatically/.test(e.textContent)), true);

await p.click('.cat-item:nth-child(2)');
await p.waitForTimeout(300);
ok('a model with no indicator says so', await p.$eval('#cat-indicator', e => e.checked), false);
ok('and offers no indicator check',
   await p.$eval('#cat-checks', e => /added automatically/.test(e.textContent)), false);

await p.click('#btn-new-model');
await p.waitForTimeout(200);
ok('a new model starts from a baseline checklist', await p.$$eval('.cat-check-row input', e => e.length), 4);
ok('with empty identity fields', await p.$eval('#cat-mfr', e => e.value), '');
ok('publishing is refused without a manufacturer',
   await p.evaluate(async () => { document.getElementById('btn-publish').click();
     await new Promise(r => setTimeout(r, 250));
     return document.getElementById('cat-msg').textContent; }),
   'A manufacturer and model are required.');

await p.fill('#cat-mfr', '3M');
await p.fill('#cat-model', 'NANO-LOK');
await p.click('#btn-add-check');
await p.waitForTimeout(150);
await p.$$eval('.cat-check-row input', els => {
  const last = els[els.length - 1];
  last.value = 'Retracts smoothly';
  last.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.click('#btn-publish');
await p.waitForTimeout(500);

// Regression: saving used to reload the model, which re-fetched its checks —
// empty for a model being published the first time — wiping what was just typed.
ok('saving does not wipe an unpublished checklist',
   (await p.evaluate(() => _catChecks.length)) > 0, true);
const pub = await p.evaluate(() => window.__published);
ok('publishing sends the checks', pub.length, 1);
ok('including the one just added', pub[0].checks.some(c => c.prompt === 'Retracts smoothly'), true);
ok('and empty rows are not published', pub[0].checks.every(c => c.prompt.trim().length > 0), true);
ok('the new version is shown', await p.$eval('#cat-version', e => e.textContent), 'v4 · published');
ok('and the lead is told earlier inspections are unaffected',
   await p.$eval('#cat-msg', e => /keep the version they were done against/.test(e.textContent)), true);

// esc() does not escape quotes, so an attribute context would break on one.
await p.evaluate(() => { _catChecks = [{ code: '', prompt: 'Says "OK" on the label' }]; renderCatChecks(); });
await p.waitForTimeout(150);
ok('a quoted prompt survives a round trip',
   await p.$eval('.cat-check-row input', e => e.value), 'Says "OK" on the label');

console.log('\npage errors:', errs.length ? errs : 'none');
await b.close(); server.close();
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
process.exit(fails || errs.length ? 1 : 0);
