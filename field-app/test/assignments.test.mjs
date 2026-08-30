// Jobs the lead pushed to this phone.
//
// The failure mode here is not a crash — it is the app becoming useless the
// moment the office network is. So the properties tested are all about what
// happens when the fetch fails:
//   • the plan cached from yesterday is still on screen, marked as of when
//   • nothing about capture is gated on the fetch having worked
//   • a tech can still make and work a job nobody assigned him
//
// And two about the work order number, which is the whole reason the office
// could not previously match up a day's work.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const ASSIGNED = [
  { id: 'a1', wo_number: 'WO-100', wo_key: 'WO100', scope: 'fall_protection',
    title: 'Comcast Northern Tier', site: 'Batavia yard', notes: 'Gate code 4412',
    due_date: '2026-09-01', status: 'open', share_peer_work: true,
    assigned_to_me: true, team_wide: false, mine_count: 2, team_count: 5,
    updated_at: '2026-08-30T09:00:00Z' },
  { id: 'a2', wo_number: 'WO-200', wo_key: 'WO200', scope: 'ladder',
    title: 'Everybody', status: 'open', share_peer_work: false,
    assigned_to_me: false, team_wide: true, mine_count: 0, team_count: 0,
    updated_at: '2026-08-30T09:00:00Z' },
];

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);

// ── The cache is what gets drawn ────────────────────────────────────────────
await p.evaluate((jobs) => {
  window.LiaAssignments._writeCache(jobs);
  renderJobList();
}, ASSIGNED);
await p.waitForTimeout(200);

ok('assigned jobs are drawn above the tech’s own',
   await p.$$eval('#assigned-body .job-card.assigned', e => e.length), 2);
ok('a job assigned to this tech is marked differently from a team-wide one',
   await p.$$eval('#assigned-body .asg-badge', e => e.map(x => x.textContent.trim())), ['You', 'Team']);
ok('the lead’s note is shown — it is why he wrote it',
   await p.$eval('#assigned-body', e => /Gate code 4412/.test(e.textContent)), true);
// Showing a team total to a tech who may not see the team's work would leak
// the size of it.
ok('the team total appears only where sharing is on',
   await p.$$eval('#assigned-body .job-card-meta', e => e.map(x => /on the job/.test(x.textContent))),
   [true, false]);
ok('and only that job offers the team list',
   await p.$$eval('#assigned-body [data-asg-team]', e => e.length), 1);

// A tech acting on a three-day-old plan should know that is what he is doing.
ok('the list says how old it is', await p.$eval('.asg-stale', e => e.textContent.trim()), 'just now');
await p.evaluate(() => {
  const c = JSON.parse(localStorage.getItem('lia-assigned-jobs'));
  c.at = new Date(Date.now() - 3 * 86400000).toISOString();
  localStorage.setItem('lia-assigned-jobs', JSON.stringify(c));
  renderAssignedList();
});
ok('and says so when it is stale', await p.$eval('.asg-stale', e => e.textContent.trim()), '3d ago');

// ── Adopting ────────────────────────────────────────────────────────────────
await p.click('#assigned-body [data-asg="a1"]'); await p.waitForTimeout(300);
ok('starting an assigned job opens it',
   await p.evaluate(() => $('screen-detail').classList.contains('active')), true);
ok('with the lead’s work order number already in',
   await p.evaluate(() => $('job-wo').value), 'WO-100');
// A tech retyping 'WO 100' for 'WO-100' is exactly what stopped the office
// matching up a day's work.
ok('and the number is not his to retype',
   await p.evaluate(() => $('job-wo').readOnly), true);
ok('the scope came from the lead too',
   await p.evaluate(() => {
     const j = Object.values(loadJobs()).find(x => x.assignedId === 'a1');
     return j.scope;
   }), 'fall_protection');

// Even if the field is forced open, the number stays the lead's — readOnly is a
// UI convention, not a guarantee.
await p.evaluate(() => {
  $('job-wo').readOnly = false;
  $('job-wo').value = 'WO 999';
  saveNow();
});
ok('and forcing the box open still cannot change it',
   await p.evaluate(() => Object.values(loadJobs()).find(x => x.assignedId === 'a1').workOrderNum),
   'WO-100');

await p.click('#btn-back'); await p.waitForTimeout(250);
ok('re-opening the same assignment reuses the job rather than making a second',
   await p.evaluate(() => {
     window.LiaAssignments.adopt({ id: 'a1', wo_number: 'WO-100', scope: 'fall_protection' });
     return Object.values(loadJobs()).filter(x => x.assignedId === 'a1').length;
   }), 1);
ok('and the button now says Open, not Start',
   await p.evaluate(() => { renderAssignedList();
     return document.querySelector('[data-asg="a1"]').textContent.trim(); }), 'Open');

// ── Offline ─────────────────────────────────────────────────────────────────
// THE property. A failed refresh must leave yesterday's plan alone.
ok('a refresh with no connection keeps the cached plan and does not throw',
   await p.evaluate(async () => {
     const r = await window.LiaAssignments.refresh();
     return { ok: r.ok, offline: r.offline, kept: r.jobs.length };
   }), { ok: false, offline: true, kept: 2 });
ok('and the list is still on screen afterwards',
   await p.evaluate(() => { renderJobList();
     return document.querySelectorAll('#assigned-body .job-card.assigned').length; }), 2);

// An assignment is a plan, not a lock: making an ordinary job must still work.
await p.evaluate(() => { localStorage.removeItem('lia-assigned-jobs'); renderJobList(); createJob('ladder'); });
await p.waitForTimeout(300);
ok('a tech can still make his own job with nothing assigned',
   await p.evaluate(() => ({ screen: $('screen-detail').classList.contains('active'),
                             editable: !$('job-wo').readOnly })),
   { screen: true, editable: true });

// The empty state must not claim there are no jobs while the lead's are on screen.
ok('“no jobs yet” is not shown while assignments are',
   await p.evaluate((jobs) => {
     localStorage.setItem('lia-field-jobs', '{}');
     window.LiaAssignments._writeCache(jobs);
     renderJobList();
     return $('jobs-empty').style.display;
   }, ASSIGNED), 'none');
ok('but it is shown when there is genuinely nothing',
   await p.evaluate(() => {
     localStorage.setItem('lia-field-jobs', '{}');
     window.LiaAssignments._writeCache([]);
     renderJobList();
     return $('jobs-empty').style.display;
   }), '');

// The plan names sites and work orders belonging to one company.
ok('signing out clears the plan off the phone',
   await p.evaluate(async (jobs) => {
     window.LiaAssignments._writeCache(jobs);
     await window.LiaSync.signOut().catch(() => {});
     return localStorage.getItem('lia-assigned-jobs');
   }, ASSIGNED), null);

// Titles and notes come from the lead and go into innerHTML.
ok('a title containing markup is escaped, not rendered',
   await p.evaluate(() => {
     window.LiaAssignments._writeCache([{ id: 'x', wo_number: 'WO-1', scope: 'ladder',
       title: '<img src=x onerror=alert(1)>', notes: '<b>n</b>', status: 'open' }]);
     renderAssignedList();
     return { imgs: document.querySelectorAll('#assigned-body img').length,
              bolds: document.querySelectorAll('#assigned-body .asg-note b').length,
              text: document.querySelector('#assigned-body .job-card-name').textContent };
   }), { imgs: 0, bolds: 0, text: '<img src=x onerror=alert(1)>' });

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close();
process.exit(fails || errs.length ? 1 : 0);
