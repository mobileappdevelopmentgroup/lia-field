// The developer's support inbox. Run with `npm run test:desktop`.
//
// Two properties are worth pinning here.
//
// The card must not exist for anyone but the developer. The real boundary is
// server-side — every RPC re-checks is_developer() — but a Support Inbox button
// sitting on a customer's copy of Lia Office invites the question of what is
// behind it, and answering "nothing you can reach" is a worse answer than never
// having shown it.
//
// And the ordering has to be by what is hurting. A tech saying he cannot finish
// a job outranks anything newer; if the inbox sorts by time, the thing that is
// costing money today sits below three suggestions.
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

// The inbox comes back already ordered by the server (severity, then unread,
// then recency). The renderer must not re-sort it into something else.
const TICKETS = [
  { id: 't-blocking', ref: 'LIA-9WK2M', kind: 'bug', severity: 'blocking', status: 'new',
    subject: 'Scanner will not focus', reporter_name: 'Ann', account_name: 'Batavia',
    app: 'field', app_version: '1.6.2', platform: 'ios', screen: 'fall protection · item',
    device: { queued: 12, queueFailing: 2, online: false, screen: '390×844' },
    created_at: '2026-08-28T14:00:00Z', last_message_at: '2026-08-28T14:00:00Z',
    unread_developer: true,
    messages: [{ id: 'm1', author_role: 'reporter', author_name: 'Ann',
                 body: 'It opens but never focuses on the plate.',
                 created_at: '2026-08-28T14:00:00Z' }] },
  { id: 't-idea', ref: 'LIA-4TQ7B', kind: 'suggestion', severity: 'idea', status: 'open',
    subject: 'Show the customer name on the job list', reporter_name: 'Ben',
    app: 'field', app_version: '1.6.2', platform: 'android', screen: 'jobs',
    device: {}, created_at: '2026-08-29T09:00:00Z', last_message_at: '2026-08-29T09:00:00Z',
    unread_developer: false,
    messages: [{ id: 'm2', author_role: 'reporter', author_name: 'Ben',
                 body: 'Would help when I have four jobs open.',
                 created_at: '2026-08-29T09:00:00Z' }] },
];

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

const calls = [];
async function boot(isDeveloper) {
  await p.addInitScript(({ tickets, dev }) => {
    window.__calls = [];
    window.api = {
      isSupabaseConfigured: async () => true,
      getSession: async () => ({ user: { email: 'dev@example.com' }, credits: 5 }),
      supportAmIDeveloper: async () => ({ ok: true, developer: dev }),
      supportInbox: async (status) => { window.__calls.push(['inbox', status]); return { ok: true, tickets }; },
      supportCounts: async () => ({ ok: true, counts: { unread: 1, open: 2, blocking: 1, total: 2 } }),
      supportReply: async (id, body) => { window.__calls.push(['reply', id, body]); return { ok: true }; },
      supportSetStatus: async (id, s) => { window.__calls.push(['status', id, s]); return { ok: true }; },
      supportMarkRead: async (id) => { window.__calls.push(['read', id]); return { ok: true }; },
      onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
      onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
      loadHistory: async () => ({ ok: true, groups: [] }),
      fpListModels: async () => ({ ok: true, models: [] }),
      mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
    };
  }, { tickets: TICKETS, dev: isDeveloper });
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(500);
}

// ── Not the developer ───────────────────────────────────────────────────────
await boot(false);
ok('an ordinary user never sees the inbox card',
   await p.$eval('#home-support', e => getComputedStyle(e).display), 'none');

// ── The developer ───────────────────────────────────────────────────────────
await p.context().clearCookies();
await boot(true);
ok('the developer does', await p.$eval('#home-support', e => getComputedStyle(e).display) !== 'none', true);
// The number worth acting on today, not the total.
ok('with what is blocking somebody shown first',
   await p.$eval('#home-support-count', e => e.textContent), '1 blocking · 2 open');

await p.click('#home-support'); await p.waitForTimeout(400);
ok('the inbox opens', await p.evaluate(() => $('screen-support').classList.contains('active')), true);
// Open is the default because a closed ticket is not work.
ok('showing open tickets by default',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'inbox').pop()[1]), 'open');
ok('both tickets are listed', await p.$$eval('.sup-item', e => e.length), 2);

// The ordering property. If this ever flips, the thing costing money today
// sits underneath a nice-to-have.
ok('what is blocking a tech leads the list',
   await p.$eval('.sup-item .sup-sev', e => e.textContent.trim()), 'Cannot finish the job');
ok('and is marked unread', await p.$$eval('.sup-item.unread', e => e.length), 1);

await p.click('.sup-item'); await p.waitForTimeout(300);
ok('opening it shows the tech’s words',
   await p.$eval('#sup-thread', e => /never focuses on the plate/.test(e.textContent)), true);
// Opening is what marks it read — not merely having it in the list, which
// would clear badges on tickets nobody looked at.
ok('and marks it read', await p.evaluate(() => window.__calls.some(c => c[0] === 'read' && c[1] === 't-blocking')), true);

// This strip is most of the value of the feature: the questions a tech cannot
// answer accurately, answered automatically.
const ctx = await p.$eval('#sup-context', e => e.textContent);
ok('the build it happened on is there without anyone asking', /1\.6\.2/.test(ctx), true);
ok('and the platform', /ios/.test(ctx), true);
ok('and where he was standing in the app', /fall protection/.test(ctx), true);
ok('and how much unsent work was on the phone', /12/.test(ctx), true);

// An empty reply must be refused rather than sent as a blank message.
await p.click('#btn-sup-reply'); await p.waitForTimeout(200);
ok('an empty reply is refused',
   await p.$eval('#sup-msg', e => /write a reply/i.test(e.textContent)), true);
ok('and nothing was sent', await p.evaluate(() => window.__calls.filter(c => c[0] === 'reply').length), 0);

await p.fill('#sup-reply', 'Fixed in the next build.');
await p.click('#btn-sup-reply'); await p.waitForTimeout(400);
ok('a reply goes to the right ticket',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'reply').pop().slice(1)),
   ['t-blocking', 'Fixed in the next build.']);
ok('the box is cleared so it cannot be sent twice',
   await p.$eval('#sup-reply', e => e.value), '');
// The tech's side of this is the whole point, so say so.
ok('and the developer is told it reaches the tech in his app',
   await p.$eval('#sup-msg', e => /appears in his app/i.test(e.textContent)), true);

await p.selectOption('#sup-status', 'open'); await p.waitForTimeout(300);
ok('setting a status says who it is for',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'status').pop().slice(1)),
   ['t-blocking', 'open']);

await p.click('[data-sup-filter="closed"]'); await p.waitForTimeout(300);
ok('the filter is passed through to the server',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'inbox').pop()[1]), 'closed');

// A ticket subject is free text typed by a tech and goes into innerHTML.
ok('a subject containing markup is escaped, not rendered',
   await p.evaluate(() => {
     _supTickets = [{ id: 'x', ref: 'LIA-1', severity: 'idea', status: 'new',
       subject: '<img src=x onerror=alert(1)>', reporter_name: '<b>hi</b>',
       messages: [] }];
     renderSupList();
     const el = document.querySelector('.sup-item-subj');
     return { imgs: document.querySelectorAll('.sup-item img').length, text: el.textContent };
   }), { imgs: 0, text: '<img src=x onerror=alert(1)>' });

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
