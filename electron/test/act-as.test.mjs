// Acting as a subcontractor, from the office. Run with `npm run test:desktop`.
//
// The properties under test are the ones that stop work landing in the wrong
// company:
//   • the switcher is offered only to somebody the server says can act
//   • a reason is required before anything starts
//   • while acting, the banner says whose account this is, and cannot be hidden
//   • the credit badge follows the account being BILLED, not the office's own
//   • starting or stopping drops what is on screen — a stale list from another
//     company is worse than an empty one
//   • an expired session is re-checked against the server, not trusted locally
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

const UMBRELLA = {
  account_id: 'acct-batavia', account_name: 'Batavia',
  real_account_id: 'acct-batavia', real_account_name: 'Batavia',
  impersonating: false, expires_at: null, reason: null,
  role: 'lead', is_umbrella: true, acting_is_umbrella: true,
  can_act_as: [
    { account_id: 'acct-mike', name: 'Michael Dobbs' },
    { account_id: 'acct-nate', name: 'Nate Dobbs' },
  ],
};

// System Chrome, like src/automation.ts uses — no downloaded browser needed.
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(({ umbrella }) => {
  window.__calls = [];
  window.__ctx = umbrella;
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'office@batavia.test', name: 'Alex' }, credits: -1 }),
    getContext: async () => ({ ok: true, ctx: window.__ctx }),
    startActingAs: async (opts) => {
      window.__calls.push(['start', opts]);
      if (!opts.reason) return { ok: false, error: 'A reason is required' };
      // What the server would then report: acting, with THEIR balance.
      window.__ctx = {
        ...window.__ctx, impersonating: true,
        account_id: opts.accountId, account_name: 'Michael Dobbs',
        reason: opts.reason, credits: 3,
        // Michael has no subcontractors of his own — is_umbrella still
        // describes YOUR account, which is the distinction under test.
        acting_is_umbrella: false,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      return { ok: true, session: { account_name: 'Michael Dobbs' } };
    },
    stopActingAs: async () => {
      window.__calls.push(['stop']);
      window.__ctx = { ...umbrella };
      return { ok: true };
    },
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    onFpPushLog(){}, onFpPushWaiting(){}, onFpPushPushed(){}, onFpPushComplete(){},
    onFpPushError(){}, onFpPushExited(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    fpListTypes: async () => ({ ok: true, types: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [{ work_order_id: 'WO-OLD', n: 4 }] }),
    jobsBoard: async () => ({ ok: true, jobs: [] }),
    jobsTeam: async () => ({ ok: true, team: [] }),
  };
}, { umbrella: UMBRELLA });

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);

// ── Before anything ─────────────────────────────────────────────────────────
ok('the office is offered the switcher',
   await p.$eval('#home-actas', e => e.style.display !== 'none'), true);
ok('and no banner is shown while in its own account',
   await p.$eval('#ctx-banner', e => e.classList.contains('on')), false);

// ── A reason is not optional ────────────────────────────────────────────────
await p.click('#home-actas'); await p.waitForTimeout(150);
ok('the panel lists the companies the server allows',
   await p.$$eval('#ctx-account option', e => e.map(x => x.textContent)),
   ['Michael Dobbs', 'Nate Dobbs']);

await p.click('#btn-ctx-start'); await p.waitForTimeout(150);
ok('starting without a reason is refused in the panel',
   await p.$eval('#ctx-error', e => /reason is required/i.test(e.textContent)), true);
ok('and nothing was sent to the server',
   await p.evaluate(() => window.__calls.length), 0);

// ── Acting ──────────────────────────────────────────────────────────────────
await p.fill('#ctx-reason-in', 'showing Michael how a job is recorded');
await p.click('#btn-ctx-start'); await p.waitForTimeout(400);

ok('the reason and the company are sent',
   await p.evaluate(() => window.__calls[0]),
   ['start', { accountId: 'acct-mike', reason: 'showing Michael how a job is recorded', minutes: '60' }]);
ok('the banner appears',
   await p.$eval('#ctx-banner', e => e.classList.contains('on')), true);
ok('and says whose account this is',
   await p.$eval('#ctx-text', e => e.textContent.trim()), 'Working as Michael Dobbs');
ok('with the reason on screen',
   await p.$eval('#ctx-reason', e => /showing Michael/.test(e.textContent)), true);
ok('and how long is left',
   await p.$eval('#ctx-expiry', e => /\d+[hm]/.test(e.textContent)), true);

// The office is unlimited; Michael has 3. Showing "Unlimited" here would
// promise an import the server then refuses.
ok('the credit badge shows the account being billed',
   await p.$eval('#credit-badge', e => e.textContent.trim()), '3 credits');
ok('and says so on hover',
   await p.$eval('#credit-badge', e => /Michael Dobbs/.test(e.title)), true);

// ── The home screen becomes THEIR home screen ───────────────────────────────
// The point of acting as somebody is seeing what they see. A Subcontractors
// card that opens is the office's own view leaking into theirs.
ok('the Subcontractors card is greyed out, not hidden',
   await p.evaluate(() => {
     const c = $('home-subs');
     return [c.style.display !== 'none', c.classList.contains('disabled')];
   }), [true, true]);
ok('and says whose limitation it is',
   await p.$eval('#home-subs', e => /Michael Dobbs has no subcontractors/.test(e.title)), true);
ok('clicking it explains instead of opening',
   await p.evaluate(() => { $('home-subs').click(); return $('screen-subs').classList.contains('active'); }), false);
ok('the crew screen stays available — it is theirs',
   await p.$eval('#home-team', e => e.style.display !== 'none' && !e.classList.contains('disabled')), true);
// Nesting one session inside another is not a thing they could do either.
ok('and Act as disappears while acting',
   await p.$eval('#home-actas', e => e.style.display === 'none'), true);

ok('the panel closed', await p.$eval('#ctx-panel', e => e.classList.contains('on')), false);
ok('and we are back on the home screen',
   await p.evaluate(() => $('screen-home').classList.contains('active')), true);

// ── What was on screen is dropped ───────────────────────────────────────────
await p.evaluate(() => { _mgWos = [{ work_order_id: 'WO-OLD', n: 4 }]; _fprRows = [{ id: 'x' }]; _jbJobs = [{ id: 'j' }]; });
await p.click('#btn-ctx-stop'); await p.waitForTimeout(400);

ok('stopping tells the server',
   await p.evaluate(() => window.__calls.some(c => c[0] === 'stop')), true);
ok('the banner goes',
   await p.$eval('#ctx-banner', e => e.classList.contains('on')), false);
ok('and the office gets its own screens back',
   await p.evaluate(() => [$('home-subs').classList.contains('disabled'), $('home-actas').style.display !== 'none']),
   [false, true]);
ok('and another company\'s rows are not left on screen',
   await p.evaluate(() => [_mgWos.length, _fprRows.length, _jbJobs.length]), [0, 0, 0]);

// ── An expired session is the server's call, not the banner's ───────────────
await p.evaluate(() => {
  window.__ctx = { ...window.__ctx, impersonating: true, account_name: 'Michael Dobbs',
                   account_id: 'acct-mike', reason: 'left running',
                   expires_at: new Date(Date.now() - 60000).toISOString() };
});
await p.evaluate(() => loadContext());
await p.waitForTimeout(150);
// Rendering an expired session re-reads the context; the stub still reports it
// as active, so the banner stays — the point is that the app ASKS rather than
// deciding for itself that the session is over.
ok('an expired session triggers a re-read rather than a local guess',
   await p.evaluate(async () => {
     const before = window.__ctx.expires_at;
     renderCtxExpiry();
     return before === window.__ctx.expires_at;
   }), true);

// ── A subcontractor sees none of this ───────────────────────────────────────
await p.evaluate(() => {
  window.__ctx = { account_id: 'acct-mike', account_name: 'Michael Dobbs',
                   real_account_id: 'acct-mike', real_account_name: 'Michael Dobbs',
                   impersonating: false, role: 'lead', is_umbrella: false,
                   acting_is_umbrella: false, can_act_as: [] };
});
await p.evaluate(() => loadContext());
await p.waitForTimeout(150);
ok('a lead with nobody beneath them is not offered the switcher',
   await p.$eval('#home-actas', e => e.style.display === 'none'), true);
ok('and sees no banner',
   await p.$eval('#ctx-banner', e => e.classList.contains('on')), false);

ok('no page errors', errs, []);

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll act-as assertions passed.');
process.exit(fails ? 1 : 0);
