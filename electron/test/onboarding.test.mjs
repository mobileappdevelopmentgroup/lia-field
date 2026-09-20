// Adding crew, and taking on a subcontractor. Run with `npm run test:desktop`.
//
// The properties under test:
//   • the doors are drawn from what the server says the caller is — a field
//     person gets neither, a subcontractor gets crew but not companies
//   • the things a certificate depends on are refused before anything is sent
//   • the server's refusal is shown in its own words, not paraphrased
//   • whose crew is on screen follows the account being acted as
//   • acting as a company from its row opens the same panel as everywhere else
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
  impersonating: false, role: 'lead', is_umbrella: true,
  can_act_as: [{ account_id: 'acct-mike', name: 'Michael Dobbs' }],
};

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(({ umbrella }) => {
  window.__calls = [];
  window.__ctx = umbrella;
  window.__team = [
    { user_id: 'u1', name: 'Alex', email: 'alex@batavia.test', role: 'lead', rep_number: null },
  ];
  window.__subs = [
    { account_id: 'acct-mike', name: 'Michael Dobbs', rep_number: '738', credits: 3,
      members: 1, records: 0, lead: 'Michael Dobbs', lead_email: 'mike@sub.test' },
    { account_id: 'acct-nate', name: 'Nate Dobbs', rep_number: '734', credits: -1,
      members: 2, records: 1724, lead: 'Nate Dobbs', lead_email: 'nate@sub.test' },
  ];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'office@batavia.test', name: 'Alex' }, credits: -1 }),
    getContext: async () => ({ ok: true, ctx: window.__ctx }),
    startActingAs: async (o) => { window.__calls.push(['start', o]); return { ok: true, session: {} }; },
    stopActingAs: async () => ({ ok: true }),
    teamMembers: async () => ({ ok: true, team: window.__team }),
    addCrewMember: async (m) => {
      window.__calls.push(['crew', m]);
      // What the server says when somebody is already placed. Shown verbatim.
      if (m.userId === 'taken') {
        return { ok: false, error: 'That person already belongs to an account. Moving them is a data migration, not an invitation.' };
      }
      window.__team.push({ user_id: m.userId, name: m.name, email: m.email, role: 'tech', rep_number: null });
      return { ok: true, accountId: 'acct-batavia' };
    },
    listSubs: async () => ({ ok: true, subs: window.__subs }),
    addSubcontractor: async (sc) => {
      window.__calls.push(['sub', sc]);
      if (sc.repNumber === '734') return { ok: false, error: 'That technician number is already in use.' };
      window.__subs.push({ account_id: 'acct-new', name: sc.name, rep_number: sc.repNumber,
                           credits: Number(sc.credits || 0), members: 1, records: 0, lead: sc.name });
      return { ok: true, sub: { account_id: 'acct-new', name: sc.name } };
    },
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    onFpPushLog(){}, onFpPushWaiting(){}, onFpPushPushed(){}, onFpPushComplete(){},
    onFpPushError(){}, onFpPushExited(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
  };
}, { umbrella: UMBRELLA });

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);

// ── Which doors are drawn ───────────────────────────────────────────────────
ok('the umbrella is offered both screens',
   await p.evaluate(() => [$('home-team').style.display !== 'none', $('home-subs').style.display !== 'none']),
   [true, true]);

// ── Crew ────────────────────────────────────────────────────────────────────
await p.click('#home-team'); await p.waitForTimeout(300);
ok('the crew screen lists the account', await p.$$eval('#team-list .ob-row', e => e.length), 1);

await p.click('#btn-team-add'); await p.waitForTimeout(150);
ok('adding without a user id is refused before anything is sent',
   await p.$eval('#team-msg', e => /user id is required/i.test(e.textContent)), true);
ok('and nothing was sent', await p.evaluate(() => window.__calls.length), 0);

await p.fill('#team-uid', 'taken');
await p.click('#btn-team-add'); await p.waitForTimeout(250);
ok('the server\'s refusal is shown in its own words',
   await p.$eval('#team-msg', e => /data migration, not an invitation/.test(e.textContent)), true);

await p.fill('#team-uid', 'u9');
await p.fill('#team-email', 'hand@batavia.test');
await p.fill('#team-name', 'New Hand');
await p.click('#btn-team-add'); await p.waitForTimeout(300);
ok('a crew member is sent with what the server needs',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'crew').pop()),
   ['crew', { userId: 'u9', email: 'hand@batavia.test', name: 'New Hand' }]);
ok('the list picks them up', await p.$$eval('#team-list .ob-row', e => e.length), 2);
ok('shown as field, with no number of their own',
   await p.$$eval('#team-list .ob-meta', e => e[0].textContent.trim()), 'lead');
ok('and the form is cleared', await p.evaluate(() => $('team-uid').value), '');

// ── Subcontractors ──────────────────────────────────────────────────────────
await p.click('#btn-team-home'); await p.waitForTimeout(150);
await p.click('#home-subs'); await p.waitForTimeout(300);
ok('the companies are listed', await p.$$eval('#subs-list .ob-row', e => e.length), 2);
ok('with the number that goes on their certificates, and their balance',
   await p.$eval('#subs-list .ob-meta', e => /no\. 738/.test(e.textContent) && /3 credits/.test(e.textContent)), true);
ok('an unlimited account says so rather than showing -1',
   await p.$$eval('#subs-list .ob-meta', e => /unlimited/.test(e[1].textContent)), true);

await p.click('#btn-sub-add'); await p.waitForTimeout(150);
ok('a company with no user id is refused',
   await p.$eval('#subs-msg', e => /user id is required/i.test(e.textContent)), true);

await p.fill('#sub-uid', 'u7');
await p.click('#btn-sub-add'); await p.waitForTimeout(150);
ok('and one with no name',
   await p.$eval('#subs-msg', e => /company name is required/i.test(e.textContent)), true);

await p.fill('#sub-name', 'Third Company');
await p.click('#btn-sub-add'); await p.waitForTimeout(150);
// The one field that cannot be left out, because it is printed on every
// certificate that company will ever issue.
ok('and one with no technician number',
   await p.$eval('#subs-msg', e => /technician number is required/i.test(e.textContent)), true);
ok('none of those reached the server',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'sub').length), 0);

await p.fill('#sub-rep', '742');
await p.fill('#sub-email', 'third@sub.test');
await p.fill('#sub-credits', '25');
await p.click('#btn-sub-add'); await p.waitForTimeout(350);
ok('a company is sent with everything the server needs',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'sub').pop()),
   ['sub', { userId: 'u7', email: 'third@sub.test', name: 'Third Company', repNumber: '742', credits: '25' }]);
ok('and appears in the list', await p.$$eval('#subs-list .ob-row', e => e.length), 3);

// Acting as one of them opens the same panel, with that company chosen.
await p.click('#subs-list .ob-row button'); await p.waitForTimeout(200);
ok('acting as a company from its row opens the usual panel',
   await p.$eval('#ctx-panel', e => e.classList.contains('on')), true);
ok('with that company already selected',
   await p.evaluate(() => $('ctx-account').value), 'acct-mike');
await p.click('#btn-ctx-cancel'); await p.waitForTimeout(100);

// ── A subcontractor, and a field person ─────────────────────────────────────
await p.evaluate(() => {
  window.__ctx = { account_id: 'acct-mike', account_name: 'Michael Dobbs',
                   real_account_id: 'acct-mike', real_account_name: 'Michael Dobbs',
                   impersonating: false, role: 'lead', is_umbrella: false, can_act_as: [] };
});
await p.evaluate(() => loadContext()); await p.waitForTimeout(150);
ok('a subcontractor gets a crew screen but not a companies one',
   await p.evaluate(() => [$('home-team').style.display !== 'none', $('home-subs').style.display !== 'none']),
   [true, false]);

await p.evaluate(() => {
  window.__ctx = { ...window.__ctx, role: 'tech' };
});
await p.evaluate(() => loadContext()); await p.waitForTimeout(150);
ok('a field person gets neither',
   await p.evaluate(() => [$('home-team').style.display !== 'none', $('home-subs').style.display !== 'none']),
   [false, false]);

// ── Whose crew is on screen follows the session ─────────────────────────────
await p.evaluate(() => {
  window.__ctx = { account_id: 'acct-mike', account_name: 'Michael Dobbs',
                   real_account_id: 'acct-batavia', real_account_name: 'Batavia',
                   impersonating: true, role: 'lead', is_umbrella: true,
                   reason: 'setting him up', expires_at: new Date(Date.now() + 3600000).toISOString(),
                   can_act_as: [{ account_id: 'acct-mike', name: 'Michael Dobbs' }] };
});
await p.evaluate(() => loadContext()); await p.waitForTimeout(150);
// Back to the home screen first: the cards live on it, and the last few
// assertions left us on Subcontractors.
await p.evaluate(() => showScreen('home')); await p.waitForTimeout(100);
await p.click('#home-team'); await p.waitForTimeout(300);
ok('the crew screen says whose crew it is',
   await p.$eval('#team-title', e => e.textContent.trim()), 'Michael Dobbs — Crew');

ok('no page errors', errs, []);

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll onboarding screen assertions passed.');
process.exit(fails ? 1 : 0);
