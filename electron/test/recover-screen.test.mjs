// The Recover Past Imports screen. Run with `npm run test:desktop`.
//
// It must say which account the ladders will land in, list the imports on this
// computer with what is still missing, refuse to send a run without its work
// order, and show a run as on record once it is.
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

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('dialog', d => d.dismiss());

await p.addInitScript(() => {
  window.__sent = [];
  window.__runs = [
    { name: 'run-2026-10-11T15-00-00.json', startedAt: '2026-10-11T15:00:00.000Z', date: '2026-10-11', total: 40,
      counts: { success: 38, partial: 0, skipped: 0, error: 2 }, imported: 38, todo: 38, already: 0, recovered: null },
    { name: 'run-2026-09-26T14-05-00.json', startedAt: '2026-09-26T14:05:00.000Z', date: '2026-09-26', total: 12,
      counts: { success: 12, partial: 0, skipped: 0, error: 0 }, imported: 12, todo: 0, already: 12, recovered: null },
    { name: 'run-2026-09-20T10-00-00.json', unreadable: true },
  ];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'nate@example.com' }, credits: -1 }),
    getContext: async () => ({ ok: true, ctx: { role: 'lead', account_name: 'Nate Dobbs', impersonating: false } }),
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onRecords(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    recoverList: async () => ({ ok: true, dir: '/Users/nate/Documents/Lia Logs', runs: window.__runs }),
    recoverRecord: async (payload) => {
      window.__sent.push(payload);
      const r = window.__runs.find(x => x.name === payload.name);
      r.already += r.todo; r.todo = 0; r.recovered = { work_order: payload.workOrderId, written: 38 };
      return { ok: true, written: 38, failed: 0, already: 0, errors: [] };
    },
  };
});

await p.goto(BASE + '/index.html');
await p.waitForTimeout(500);
await p.click('#home-advanced'); await p.waitForTimeout(150);
ok('Recover Past Imports is on the Advanced menu', await p.$eval('#adv-recover', e => e.offsetParent !== null), true);
await p.click('#adv-recover'); await p.waitForTimeout(400);
ok('it opens its own screen', await p.$eval('#screen-recover', e => e.classList.contains('active')), true);
ok('it says which account the ladders go into, and how to do a subcontractor\'s',
   await p.$eval('#recover-account', e => /Nate Dobbs/.test(e.textContent) && /act as them/.test(e.textContent)), true);
ok('it says how many imports are missing, and that a log could not be read',
   await p.$eval('#recover-msg', e => e.textContent.replace(/\s+/g, ' ').trim()),
   '1 import with ladders still to record. 1 log could not be read.');

const rows = () => p.$$eval('#recover-body tr', trs => trs.map(tr =>
  [...tr.querySelectorAll('td')].slice(1, 4).map(td => td.textContent.trim())));
ok('each import shows what went in, what is already on record and what is missing',
   await rows(), [['38 (2 failed)', '0', '38'], ['12', '12', '0']]);
ok('one that is complete offers nothing to press',
   await p.$$eval('#recover-body tr', trs => [!!trs[0].querySelector('.recover-go'), !!trs[1].querySelector('.recover-go')]),
   [true, false]);

await p.click('#recover-body tr .recover-go'); await p.waitForTimeout(200);
ok('without a work order nothing is sent', await p.evaluate(() => window.__sent.length), 0);
ok('and it says why', await p.$eval('#recover-body tr .recover-out', e => e.textContent), 'Type the work order first.');

await p.fill('#recover-body tr .recover-wo', ' 98927 ');
await p.click('#recover-body tr .recover-go'); await p.waitForTimeout(400);
ok('with one, that run is sent under it', await p.evaluate(() => window.__sent),
   [{ name: 'run-2026-10-11T15-00-00.json', workOrderId: '98927' }]);
ok('and it then shows as on record, with its work order',
   await p.$eval('#recover-body tr', tr => /On record/.test(tr.textContent) && /WO 98927/.test(tr.textContent)), true);
ok('nothing left to record', await p.$eval('#recover-msg', e => e.textContent.trim()).then(t => /Every import/.test(t)), true);

ok('no page errors', errs, []);
await b.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nRESULT: all passed');
process.exit(fails ? 1 : 0);
