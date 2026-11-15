// Training and test accounts (migration 41). Run with `npm run test:desktop`.
//
// What is pinned here:
//   * the card exists only for the developer (the server refuses everybody
//     else anyway, but a button nobody can use invites questions);
//   * the logins a create returns are shown once, and forgotten on leaving;
//   * erasing needs ERASE typed — one stray click must never delete anything;
//   * signed in to a training account, the purple banner says so and names
//     the only BSI work order imports may go to.
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

const FAMILY = {
  account_id: 'acc-root', name: 'Training: Batavia demo', created_at: '2026-11-15T10:00:00Z',
  expires_at: '2026-11-29T10:00:00Z', expired: false, bsi_work_orders: ['99999'],
  preview_token: 'a'.repeat(64),
  accounts: [{ account_id: 'acc-root', name: 'Training: Batavia demo', is_root: true }],
  members: [{ user_id: 'u1', email: 't-abcd-01@training.mobileappdevelopmentgroup.com', name: 'Training office', role: 'lead', account_name: 'Training: Batavia demo' }],
  ladders: 3, fp: 1,
};

const b = await chromium.launch();
const errs = [];

async function boot({ dev, ctx }) {
  const p = await b.newPage();
  p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(({ dev, ctx, family }) => {
    window.__calls = [];
    window.__families = [family];
    window.__ctx = ctx;
    window.api = {
      isSupabaseConfigured: async () => true,
      getSession: async () => ({ user: { email: 'dev@example.com' }, credits: 5 }),
      getContext: async () => ({ ok: true, ctx: window.__ctx }),
      supportAmIDeveloper: async () => ({ ok: true, developer: dev }),
      supportCounts: async () => ({ ok: true, counts: { unread: 0, open: 0, blocking: 0, total: 0 } }),
      trainingList: async () => { window.__calls.push(['list']); return { ok: true, accounts: window.__families }; },
      trainingCreate: async (o) => { window.__calls.push(['create', o]);
        return { ok: true, result: { name: 'Training: ' + o.name, logins: [
          { email: 't-wxyz-01@training.mobileappdevelopmentgroup.com', password: 'kmrt-4829-pxq', name: 'Training office', role: 'lead', where: 'Office (umbrella)' },
          { email: 't-wxyz-03@training.mobileappdevelopmentgroup.com', password: 'abcd-2345-efg', name: 'Trainee 1', role: 'tech', where: 'Crew' } ] } }; },
      trainingUpdate: async (o) => { window.__calls.push(['update', o]); return { ok: true }; },
      trainingErase: async (id) => { window.__calls.push(['erase', id]); window.__families = []; return { ok: true, result: { ok: true } }; },
      trainingFinish: async () => ({ ok: true }),
      onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
      onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onRecords(){}, onCreditError(){}, onPaused(){}, onResumed(){},
      loadHistory: async () => ({ ok: true, groups: [] }),
      fpListModels: async () => ({ ok: true, models: [] }),
      mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
    };
  }, { dev, ctx, family: FAMILY });
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(600);
  return p;
}

const REAL = { account_id: 'nate', account_name: 'Nate', role: 'lead', is_umbrella: false, can_act_as: [], is_training: false };

// ── Not the developer ───────────────────────────────────────────────────────
let p = await boot({ dev: false, ctx: REAL });
ok('an ordinary user never sees the Training Accounts card',
   await p.$eval('#adv-training', e => getComputedStyle(e).display), 'none');
ok('and a real account shows no training banner',
   await p.$eval('#training-banner', e => getComputedStyle(e).display), 'none');
await p.close();

// ── The developer ───────────────────────────────────────────────────────────
p = await boot({ dev: true, ctx: REAL });
ok('the developer sees the card', await p.$eval('#adv-training', e => getComputedStyle(e).display) !== 'none', true);
await p.evaluate(() => showScreen('advanced'));
await p.click('#adv-training'); await p.waitForTimeout(400);
ok('the screen opens', await p.evaluate(() => $('screen-training').classList.contains('active')), true);
ok('the family is listed with its BSI training work order',
   await p.$eval('.tr-family .tr-meta', e => /99999/.test(e.textContent) && /3 ladders/.test(e.textContent)), true);

// Erase is two steps.
await p.click('[data-tr="erase"]'); await p.waitForTimeout(100);
await p.click('[data-tr="erase-confirm"]'); await p.waitForTimeout(200);
ok('erase without typing ERASE does nothing',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'erase').length), 0);
await p.fill('[data-tr-confirm-input]', 'erase');
await p.click('[data-tr="erase-confirm"]'); await p.waitForTimeout(400);
ok('typing it erases that family, by id',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'erase').map(c => c[1])), ['acc-root']);
ok('and the list reloads empty', await p.$$eval('.tr-family', e => e.length), 0);

// Create.
await p.fill('#tr-name', 'Batavia demo');
await p.fill('#tr-techs', '2');
await p.fill('#tr-wos', '99999, 88888');
await p.click('#btn-tr-create'); await p.waitForTimeout(400);
ok('create sends the name, trainee count and the work orders as a list',
   await p.evaluate(() => { const o = window.__calls.find(c => c[0] === 'create')[1]; return [o.name, o.techs, o.bsiWorkOrders]; }),
   ['Batavia demo', 2, ['99999', '88888']]);
ok('the logins are shown, passwords included',
   await p.$eval('#tr-creds-table', e => /kmrt-4829-pxq/.test(e.textContent) && /t-wxyz-03@/.test(e.textContent)), true);
await p.click('#btn-training-back'); await p.waitForTimeout(200);
ok('leaving the screen forgets them',
   await p.evaluate(() => _trCreds.length === 0 && !/kmrt/.test($('tr-creds-table').textContent)), true);
await p.close();

// ── Signed in to a training account ─────────────────────────────────────────
p = await boot({ dev: false, ctx: { ...REAL, account_name: 'Training crew: Batavia demo', is_training: true,
                                     training_bsi_work_orders: ['99999'] } });
ok('the training banner is on', await p.$eval('#training-banner', e => getComputedStyle(e).display), 'flex');
ok('and names the only work order BSI imports may go to',
   await p.$eval('#training-banner-text', e => /99999/.test(e.textContent) && /never submit/.test(e.textContent)), true);
await p.close();

console.log(errs.length ? 'page errors: ' + errs.join(' | ') : '\npage errors: none');
if (errs.length) fails++;
await b.close(); server.close();
console.log(fails ? `RESULT: ${fails} failed` : 'RESULT: all passed');
process.exit(fails ? 1 : 0);
