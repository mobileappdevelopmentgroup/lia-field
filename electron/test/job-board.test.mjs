// The lead's job board. Run with `npm run test:desktop`.
//
// The properties under test are the ones a lead's day depends on:
//   • a job assigned to nobody appears on no phone, and is refused rather than
//     saved looking fine
//   • "everybody" and a named list are not both submitted
//   • peer visibility is presented as the read-only, off-by-default thing it is
//   • deleting a job says, on screen, that it destroys no work
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

const TEAM = [
  { user_id: 'u1', name: 'Nate', email: 'nate@acme.com', role: 'lead' },
  { user_id: 'u2', name: 'Alex', email: 'alex@acme.com', role: 'tech' },
  { user_id: 'u3', name: 'Sam',  email: 'sam@acme.com',  role: 'tech' },
];

const JOBS = [
  { id: 'j1', wo_number: 'WO-100', scope: 'fall_protection', title: 'Comcast Northern Tier',
    site: 'Batavia yard', notes: 'Gate code 4412', due_date: '2026-09-01', status: 'open',
    assign_all: false, share_peer_work: false,
    assignees: [{ user_id: 'u2', name: 'Alex' }],
    progress: [{ user_id: 'u2', who: 'Alex', n: 7, last_at: '2026-08-29T18:00:00Z' },
               { user_id: 'u3', who: 'Sam',  n: 3, last_at: '2026-08-29T17:00:00Z' }],
    total: 10 },
  { id: 'j2', wo_number: 'WO-200', scope: 'ladder', title: 'Everybody', status: 'closed',
    assign_all: true, share_peer_work: true, close_note: 'All done, gate locked',
    assignees: [], progress: [], total: 0 },
];

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(({ jobs, team }) => {
  window.__calls = [];
  window.__jobs = jobs;
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'nate@acme.com' }, credits: 5 }),
    jobsBoard: async (s) => { window.__calls.push(['board', s]); return { ok: true, jobs: window.__jobs }; },
    jobsTeam: async () => ({ ok: true, team }),
    jobsDetail: async (id) => ({ ok: true, detail: {} }),
    jobsSave: async (pl) => { window.__calls.push(['save', pl]); return { ok: true, result: { job: { id: 'j1' } } }; },
    jobsClose: async (pl) => { window.__calls.push(['close', pl]); return { ok: true, result: {} }; },
    jobsDelete: async (pl) => { window.__calls.push(['del', pl]); return { ok: true, result: 1 }; },
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    onFpPushLog(){}, onFpPushWaiting(){}, onFpPushPushed(){}, onFpPushComplete(){},
    onFpPushError(){}, onFpPushExited(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
  };
}, { jobs: JOBS, team: TEAM });

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);
await p.click('#home-jobs'); await p.waitForTimeout(400);

ok('the board opens', await p.evaluate(() => $('screen-jobs').classList.contains('active')), true);
ok('jobs are listed', await p.$$eval('#jb-list .jb-item', e => e.length), 2);
ok('with who is on each',
   await p.$$eval('#jb-list .jb-meta', e => e.map(x => x.textContent.trim().split(' ·')[0])),
   ['Alex', 'Whole team']);
ok('and how much has come back',
   await p.$$eval('#jb-list .jb-count', e => e.map(x => x.textContent.trim())),
   ['10 recorded', '0 recorded']);

await p.click('#jb-list .jb-item'); await p.waitForTimeout(250);
// The whole reason the lead opens this screen at four o'clock.
ok('opening a job breaks the work down by tech',
   await p.$$eval('.jb-prog-row .jb-n', e => e.map(x => x.textContent.trim())), ['7', '3']);
ok('peer visibility says which way it is set, in words',
   await p.$eval('#jb-detail', e => /Off — each tech sees only his own/.test(e.textContent)), true);
// A lead who thinks deleting a job deletes the day's certificates will never
// tidy his board, and a lead who thinks it doesn't when it does is worse.
ok('and deleting is explicitly said to destroy no work',
   await p.$eval('#jb-detail', e => /matched by number and are not touched/.test(e.textContent)), true);

// ── Creating ────────────────────────────────────────────────────────────────
await p.click('#btn-jb-new'); await p.waitForTimeout(250);
ok('the form offers the whole team to assign to',
   await p.$$eval('#jb-who label', e => e.map(x => x.textContent.trim())), ['Nate', 'Alex', 'Sam']);
ok('sharing is off on a new job',
   await p.evaluate(() => $('jb-share').checked), false);

await p.click('#btn-jb-save'); await p.waitForTimeout(200);
ok('a job with no work order is refused',
   await p.$eval('#jb-msg', e => /work order number is required/i.test(e.textContent)), true);
ok('and nothing was sent', await p.evaluate(() => window.__calls.filter(c => c[0] === 'save').length), 0);

await p.fill('#jb-wo', 'WO-300');
await p.click('#btn-jb-save'); await p.waitForTimeout(200);
// A job assigned to nobody shows up on no phone, which looks exactly like the
// feature being broken.
ok('a job assigned to nobody is refused',
   await p.$eval('#jb-msg', e => /Assign it to somebody/i.test(e.textContent)), true);
ok('and still nothing was sent',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'save').length), 0);

// Ticking "everybody" must not also submit a named list — the two together are
// a contradiction the lead would only discover later, on somebody's phone.
await p.click('[data-jb-who="u2"]');
await p.click('#jb-all'); await p.waitForTimeout(150);
ok('ticking the whole team disables the named list',
   await p.$$eval('#jb-who input', e => e.every(x => x.disabled)), true);
await p.click('#btn-jb-save'); await p.waitForTimeout(250);
ok('and only the team-wide flag goes up',
   await p.evaluate(() => {
     const c = window.__calls.filter(x => x[0] === 'save').pop()[1];
     return { all: c.assign_all, who: c.assignees, wo: c.wo_number };
   }), { all: true, who: [], wo: 'WO-300' });

// ── Naming people ───────────────────────────────────────────────────────────
await p.click('#btn-jb-new'); await p.waitForTimeout(200);
await p.fill('#jb-wo', 'WO-400');
await p.fill('#jb-title', 'Second shift');
await p.click('[data-jb-who="u2"]');
await p.click('[data-jb-who="u3"]');
await p.click('#jb-share');
await p.click('#btn-jb-save'); await p.waitForTimeout(250);
ok('a named assignment carries exactly those people',
   await p.evaluate(() => {
     const c = window.__calls.filter(x => x[0] === 'save').pop()[1];
     return { all: c.assign_all, who: c.assignees, share: c.share_peer_work, title: c.title };
   }), { all: false, who: ['u2', 'u3'], share: true, title: 'Second shift' });

// ── Closing out ─────────────────────────────────────────────────────────────
await p.click('#jb-list .jb-item'); await p.waitForTimeout(250);
p.once('dialog', d => d.accept('Twelve done'));
await p.click('#btn-jb-close'); await p.waitForTimeout(300);
ok('marking complete sends the job and the note',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'close').pop()[1]),
   { job_id: 'j1', note: 'Twelve done' });
// A tech who watches the job vanish at 3pm assumes his work went with it.
ok('and the lead is told it stays on the phones for a while',
   await p.$eval('#jb-msg', e => /stays on the techs’ phones/i.test(e.textContent)), true);

// A closed job offers Reopen, not Mark complete.
await p.evaluate(() => { _jbSelected = 'j2'; _jbEditing = null; renderJbDetail(); });
await p.waitForTimeout(200);
ok('a closed job offers Reopen', await p.evaluate(() => !!$('btn-jb-reopen') && !$('btn-jb-close')), true);
ok('and shows how it was closed out',
   await p.$eval('#jb-detail', e => /All done, gate locked/.test(e.textContent)), true);

// Titles, sites and notes are free text and go into innerHTML.
ok('a title containing markup is escaped, not rendered',
   await p.evaluate(() => {
     _jbJobs = [{ id: 'x', wo_number: '<img src=x onerror=alert(1)>', title: '<b>T</b>',
                  status: 'open', assignees: [], progress: [], total: 0 }];
     _jbSelected = null; renderJbList();
     return { imgs: document.querySelectorAll('#jb-list img').length,
              bolds: document.querySelectorAll('#jb-list .jb-title b').length,
              text: document.querySelector('.jb-wo').textContent };
   }), { imgs: 0, bolds: 0, text: '<img src=x onerror=alert(1)>' });

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
