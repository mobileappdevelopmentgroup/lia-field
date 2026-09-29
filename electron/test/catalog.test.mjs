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
  // The checklist lives on the TYPE. A model only carries its own when it has
  // been deliberately given one.
  const types = [
    { id: 't1', slug: 'body_harness', name: 'Body harness', sort_order: 1,
      template_id: 'tpl1', template_version: 1, checks: [
        { ord: 0, code: 'labels', prompt: 'Are all labels and markings present, secured and legible?',
          answer_style: 'yes_no', pass_answer: true },
        { ord: 1, code: 'impact_indicator', prompt: 'Has the impact indicator been activated?',
          answer_style: 'yes_no', pass_answer: false },
        { ord: 2, code: 'webbing', prompt: 'Webbing / rope / cable',
          answer_style: 'pass_fail', pass_answer: true }] },
    { id: 't2', slug: 'climbing_belt', name: 'Climbing belt', sort_order: 2,
      template_id: 'tpl2', template_version: 1, checks: [
        { ord: 0, code: 'labels', prompt: 'Are all labels and markings present, secured and legible?',
          answer_style: 'yes_no', pass_answer: true },
        { ord: 1, code: 'leather_stitching', prompt: 'Leather and stitching',
          answer_style: 'pass_fail', pass_answer: true }] },
  ];
  window.__published = [];
  window.__publishedTypes = [];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com', name: 'Lead' }, credits: 5 }),
    fpListModels: async () => ({ ok: true, models }),
    fpListTypes: async () => ({ ok: true, types }),
    fpSaveType: async (t) => { const id = 't' + (types.length + 1);
      types.push({ id, slug: t.name.toLowerCase().replace(/\W+/g,'_'), name: t.name,
                   sort_order: 99, template_id: null, template_version: null, checks: [] });
      return { ok: true, id }; },
    fpPublishTypeChecks: async (id, checks) => {
      window.__publishedTypes.push({ id, checks });
      const t = types.find(x => x.id === id);
      if (t) { t.checks = checks; t.template_version = (t.template_version || 0) + 1; }
      return { ok: true, version: t ? t.template_version : 1 }; },
    // m1 has its own list; m2 follows its type's.
    fpGetChecks: async (id) => id === 'm1'
      ? { ok: true, version: 3, published: true, inherited: false, checks: [
          { ord: 0, code: 'labels', prompt: 'Labels legible', answer_style: 'yes_no', pass_answer: true },
          { ord: 1, code: 'webbing', prompt: 'Webbing intact', answer_style: 'pass_fail', pass_answer: true }] }
      : { ok: true, version: 0, published: false, inherited: true, checks: [
          { ord: 0, code: 'labels', prompt: 'Are all labels and markings present, secured and legible?',
            answer_style: 'yes_no', pass_answer: true, inherited: true },
          { ord: 1, code: 'webbing', prompt: 'Webbing / rope / cable',
            answer_style: 'pass_fail', pass_answer: true, inherited: true }] },
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

ok('showScreen reaches a screen it was never told about',
   await p.$eval('#screen-catalog', e => e.classList.contains('active')), true);

// ── Equipment types ────────────────────────────────────────────────────────
// The screen opens on types, because that is what owns a checklist.
ok('the catalogue opens on equipment types',
   await p.$eval('#tab-types', e => e.classList.contains('on')), true);
ok('and lists them', await p.$$eval('#cat-types .cat-item', e => e.length), 2);

await p.click('#cat-types .cat-item:nth-child(1)');
await p.waitForTimeout(300);
ok('selecting a type loads its checks', await p.$$eval('#cat-type-checks .cat-check-row', e => e.length), 3);
ok('and shows which version is live', await p.$eval('#cat-type-version', e => e.textContent), 'v1');
// The polarity has to be visible, not inferred from the wording.
ok('the impact indicator is shown as failing on Yes',
   await p.$$eval('#cat-type-checks select', e => e.map(x => x.value)),
   ['yes_no:true', 'yes_no:false', 'pass_fail:true']);

await p.click('#cat-types .cat-item:nth-child(2)');
await p.waitForTimeout(300);
ok('a different type has a different list',
   await p.$$eval('#cat-type-checks .cat-check-row input', e => e.map(x => x.value)),
   ['Are all labels and markings present, secured and legible?', 'Leather and stitching']);
ok('and is not asked about an indicator it does not have',
   await p.$$eval('#cat-type-checks select', e => e.length), 2);

// More parameters can be added to a type at any time.
await p.click('#btn-add-type-check');
await p.waitForTimeout(150);
await p.$$eval('#cat-type-checks .cat-check-row input', els => {
  const last = els[els.length - 1];
  last.value = 'Tool pouches / accessories';
  last.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.click('#btn-publish-type');
await p.waitForTimeout(400);
const pubT = await p.evaluate(() => window.__publishedTypes);
ok('publishing a type sends its checks', pubT.length, 1);
ok('including the one just added',
   pubT[0].checks.some(c => c.prompt === 'Tool pouches / accessories'), true);
ok('every published check carries how it is answered',
   pubT[0].checks.every(c => c.answer_style && typeof c.pass_answer === 'boolean'), true);
ok('and the lead is told earlier inspections are unaffected',
   await p.$eval('#cat-type-msg', e => /keep the version they were done against/.test(e.textContent)), true);

// ── Models ─────────────────────────────────────────────────────────────────
await p.click('#tab-models');
await p.waitForTimeout(200);
ok('the models tab lists the account models', await p.$$eval('#cat-models .cat-item', e => e.length), 2);

await p.click('#cat-models .cat-item:nth-child(1)');
await p.waitForTimeout(300);
ok('a model with its own list loads it', await p.$$eval('#cat-checks .cat-check-row', e => e.length), 2);
ok('and shows which version is live', await p.$eval('#cat-version', e => e.textContent), 'v3 · published');
ok('with no inherited notice', await p.$eval('#cat-inherited', e => e.style.display), 'none');

await p.click('#cat-models .cat-item:nth-child(2)');
await p.waitForTimeout(300);
ok('a model with no list of its own follows its type',
   await p.$eval('#cat-version', e => e.textContent), 'following its type');
ok('and says so plainly',
   await p.$eval('#cat-inherited', e => /stops following the type/.test(e.textContent)), true);
ok('showing the checks it will actually be asked',
   await p.$$eval('#cat-checks .cat-check-row', e => e.length), 2);

// The equipment type is picked, not typed — the checklist depends on it.
ok('the type is a picker, not a text field',
   await p.$eval('#cat-type', e => e.tagName), 'SELECT');
ok('offering every type in the catalogue',
   await p.$$eval('#cat-type option', e => e.map(x => x.value)), ['', 'Body harness', 'Climbing belt']);

await p.click('#btn-new-model');
await p.waitForTimeout(200);
ok('a new model starts with no list of its own', await p.$$eval('#cat-checks .cat-check-row', e => e.length), 0);
ok('with empty identity fields', await p.$eval('#cat-mfr', e => e.value), '');

// Picking the type shows what it will be asked, rather than a blank panel.
await p.selectOption('#cat-type', 'Body harness');
await p.waitForTimeout(200);
ok('picking a type fills in the checks it inherits',
   await p.$$eval('#cat-checks .cat-check-row input', e => e.map(x => x.value)),
   ['Are all labels and markings present, secured and legible?',
    'Has the impact indicator been activated?', 'Webbing / rope / cable']);
ok('publishing is refused without a manufacturer',
   await p.evaluate(async () => { document.getElementById('btn-publish').click();
     await new Promise(r => setTimeout(r, 250));
     return document.getElementById('cat-msg').textContent; }),
   'A manufacturer and model are required.');

await p.fill('#cat-mfr', '3M');
await p.fill('#cat-model', 'NANO-LOK');
await p.click('#btn-add-check');
await p.waitForTimeout(150);
await p.$$eval('#cat-checks .cat-check-row input', els => {
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
await p.evaluate(() => {
  _catChecks = [{ code: '', prompt: 'Says "OK" on the label', answer_style: 'pass_fail', pass_answer: true }];
  renderCatChecks();
});
await p.waitForTimeout(150);
ok('a quoted prompt survives a round trip',
   await p.$eval('#cat-checks .cat-check-row input', e => e.value), 'Says "OK" on the label');

console.log('\npage errors:', errs.length ? errs : 'none');
await b.close(); server.close();
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
process.exit(fails || errs.length ? 1 : 0);
