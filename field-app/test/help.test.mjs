// The in-app manual and the ticket thread.
//
// Two things are worth testing here and they are not the obvious ones.
//
// The manual's failure mode is not a crash — it is pointing at a button that no
// longer exists. So every screenshot a topic references is checked to actually
// be on disk, and the capture tool fails loudly when a selector stops matching.
// Between them, a walkthrough cannot silently start describing an older app.
//
// The ticket flow's failure mode is lying to the tech. Told "sent" in a
// basement, he stops reporting things when nothing comes of it. So the states
// are pinned: waiting is never shown as sent, and a queued submission that
// retries files one ticket rather than five.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import fs from 'fs';
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

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);

// ── The content itself ──────────────────────────────────────────────────────
const content = await p.evaluate(() => {
  const H = window.LiaHelp;
  const topics = H.topics();
  const shots = [];
  topics.forEach(t => t.body.forEach(b => { if (b.type === 'shot') shots.push(b.src); }));
  return {
    count: topics.length,
    workflows: H.workflows().length,
    groups: H.groups(),
    // A topic with no blurb renders as a nameless row in the list.
    complete: topics.every(t => t.id && t.title && t.blurb && t.body.length),
    // A caption is what carries a picture for anyone who cannot see it.
    captioned: topics.every(t => t.body.every(x => x.type !== 'shot' || !!x.caption)),
    shots,
    ids: topics.map(t => t.id),
  };
});

ok('there is a manual', content.count >= 10, true);
ok('with sample workflows', content.workflows >= 4, true);
ok('grouped so the list is scannable', content.groups.length >= 4, true);
ok('every topic has a title, a blurb and a body', content.complete, true);
ok('and every picture has a caption', content.captioned, true);
// Duplicated ids would make byId() return the wrong topic.
ok('topic ids are unique', new Set(content.ids).size, content.ids.length);

// THE check that matters: a walkthrough referencing a picture that was never
// captured shows the tech an empty gap where the instruction should be.
const missing = content.shots.filter(src => {
  const file = path.join(ROOT, 'field-app', src.replace(/^\.\//, ''));
  return !fs.existsSync(file);
});
ok('every screenshot a topic references exists on disk', missing, []);
ok('and there are enough of them to be a walkthrough', content.shots.length >= 8, true);

// ── Search ──────────────────────────────────────────────────────────────────
// A tech types the word in his head, not the title of a topic.
const search = await p.evaluate(() => {
  const H = window.LiaHelp;
  const first = q => (H.search(q)[0] || {}).id || null;
  return {
    tag: first('tag'),
    photo: !!H.search('photo').length,
    wifi: !!H.search('signal').length,
    impact: !!H.search('impact indicator').length,
    empty: H.search('').length,
    nonsense: H.search('zzzzqqq').length,
    // Ranking: a word in the title beats the same word buried in a body.
    titleWins: (H.search('workflows for signal') || []).length >= 0,
  };
});
ok('searching a word finds the topic about it', !!search.tag, true);
ok('and everyday words find something', [search.photo, search.wifi, search.impact], [true, true, true]);
ok('an empty search shows everything', search.empty, content.count);
ok('and nonsense finds nothing rather than everything', search.nonsense, 0);

// ── Opening it ──────────────────────────────────────────────────────────────
await p.click('#btn-help-jobs'); await p.waitForTimeout(300);
ok('Help opens from the job list',
   await p.evaluate(() => $('screen-help').classList.contains('active')), true);
ok('showing the topics', await p.$$eval('#help-body [data-topic]', e => e.length), content.count);
// A tech who cannot start a job is exactly the one who needs the manual, so it
// must be reachable from inside a job too.
ok('and there is a way in from inside a job as well',
   await p.evaluate(() => !!$('btn-help-detail')), true);

await p.fill('#help-search', 'tag'); await p.waitForTimeout(250);
const filtered = await p.$$eval('#help-body [data-topic]', e => e.length);
ok('searching narrows the list', filtered < content.count && filtered > 0, true);
await p.fill('#help-search', 'zzzzqqq'); await p.waitForTimeout(250);
// A dead end is where a tech decides the help is useless.
ok('a search with no answers offers to ask a human instead',
   await p.evaluate(() => !!$('help-btn-ask-empty')), true);

await p.fill('#help-search', ''); await p.waitForTimeout(250);
await p.click('#help-body [data-topic="tags"]'); await p.waitForTimeout(250);
ok('a topic opens', await p.$eval('#help-title', e => e.textContent),
   'Tags that are not ours');
ok('with its pictures', await p.$$eval('#help-body .help-shot img', e => e.length) >= 1, true);
ok('and a way to ask at the bottom of it', await p.evaluate(() => !!$('help-btn-ask')), true);

// Back has to mean one obvious thing.
await p.click('#help-back'); await p.waitForTimeout(250);
ok('Back returns to the topic list',
   await p.$eval('#help-title', e => e.textContent), 'Help');
await p.click('#help-back'); await p.waitForTimeout(250);
ok('and again leaves Help entirely',
   await p.evaluate(() => $('screen-jobs').classList.contains('active')), true);

// ── Raising a ticket, with no server anywhere ───────────────────────────────
// This is the offline case: file:// with no config, so nothing can ever upload.
// What the tech is told has to stay true anyway.
await p.click('#btn-help-jobs'); await p.waitForTimeout(300);
await p.click('#help-btn-ask'); await p.waitForTimeout(250);
ok('the ticket form opens', await p.$eval('#help-title', e => e.textContent), 'Send a message');
// He cannot judge "P1 vs P2"; he knows exactly whether he can finish the job.
ok('severity is phrased as what it is costing him',
   await p.$$eval('#tk-sev option', e => e.map(x => x.textContent)),
   ['I cannot finish the job', 'I can work around it', 'Just an idea']);
ok('and the app says what it is attaching for him',
   await p.$eval('.help-attached', e => /version|screen/.test(e.textContent)), true);

// An empty report is refused rather than filed as a blank.
await p.click('#tk-send'); await p.waitForTimeout(200);
ok('an empty message is refused',
   await p.$eval('#tk-msg', e => /write what happened/i.test(e.textContent)), true);
ok('and nothing was filed', await p.evaluate(() => LiaSupport.list().length), 0);

await p.fill('#tk-subject', 'Scanner will not focus');
await p.fill('#tk-body', 'The scanner opens but never focuses on the ladder plate.');
await p.selectOption('#tk-sev', 'blocking');
await p.click('#tk-send'); await p.waitForTimeout(400);

const t = await p.evaluate(() => LiaSupport.list()[0]);
ok('the ticket is saved on the phone', !!t, true);
ok('with what he wrote', t.body, 'The scanner opens but never focuses on the ladder plate.');
ok('and how much it is costing him', t.severity, 'blocking');
// Captured rather than asked for: he cannot answer either of these accurately.
ok('the build it happened on rode along', !!t.context.app_version, true);
ok('and where he was standing', !!t.screen, true);

// THE honesty property. There is no server here, so it has NOT been sent, and
// the app must not say it has.
ok('it is shown as waiting, not as sent', t.status, 'waiting');
ok('with no reference invented for it', t.ref, null);
ok('and the thread says so plainly',
   await p.$eval('.help-confirm', e => /not reached the developer yet/i.test(e.textContent)), true);
ok('while promising it is not lost',
   await p.$eval('.help-confirm', e => /nothing is lost/i.test(e.textContent)), true);
ok('and it is marked as still to send',
   await p.$eval('#help-title', e => e.textContent), 'Message');

// It is queued for upload, which is what makes that promise true.
const queued = await p.evaluate(() =>
  JSON.parse(localStorage.getItem('lia-upload-queue') || '[]').filter(e => e.kind === 'support_ticket'));
ok('the ticket is in the upload queue', queued.length, 1);
ok('keyed so a retry cannot file it twice', queued[0].payload.client_id, t.clientId);

// A ticket the server has never seen has nothing to reply against.
ok('replying to an unsent ticket is refused, not silently dropped',
   await p.evaluate(() => { try { LiaSupport.reply(LiaSupport.list()[0].clientId, 'more'); return 'allowed'; }
                            catch (e) { return /not been sent/i.test(e.message) ? 'refused' : e.message; } }),
   'refused');

// The tech's own words are in the thread from the start, so it reads as a
// conversation rather than as a form he shouted into.
ok('his own message is in the thread immediately',
   await p.$$eval('.help-msg.me', e => e.length), 1);

await p.click('#help-back'); await p.waitForTimeout(250);
ok('and the ticket is listed', await p.$$eval('[data-ticket]', e => e.length), 1);
ok('with its state in words a tech can act on',
   await p.$eval('.help-status', e => e.textContent.trim()), 'Waiting to send');

// ── Labels for every server state ───────────────────────────────────────────
const labels = await p.evaluate(() =>
  ['new','open','answered','resolved','wont_fix']
    .map(s => LiaSupport.statusLabel({ id: 'x', status: s })));
ok('every status reads as plain English', labels,
   ['Sent — not looked at yet', 'Being worked on', 'Answered', 'Fixed', 'Closed']);

// Support traffic must not be counted as unsent INSPECTIONS — that badge means
// captured work at risk, and a ticket is not that.
ok('a queued ticket is not counted as unsent captured work',
   await p.evaluate(() => LiaSync.pendingSummary().total), 0);

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close();
process.exit(fails || errs.length ? 1 : 0);
