// The public certificate site (inspection-site/index.html), driven in a real
// browser against a stand-in for the database. Served at both / and /fp/,
// exactly as production serves it.
//
// What has to hold — this is the page a customer makes a safety call from:
//   * every way in finds the item: serial (however typed), tag number,
//     certificate code, a tag's link, a scanned URL, a work order;
//   * the result is never rosier than the record: destroyed and failed beat
//     the calendar, overdue is not failed, "not found" is not "valid";
//   * a work order lists everything, removed-from-service first, and exports;
//   * old links keep working (/?t=, /fp/?t=&s=, ?serial=, ?wo=), including a
//     tag whose code no longer resolves but whose serial does;
//   * it works before migration 40 is live (no tag_label_key on ladders);
//   * view tracking fires for outside visits, never for ?src=app;
//   * nothing from the database is ever rendered as markup.
//
//   node inspection-site/test/site.test.mjs
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'inspection-site/index.html'), 'utf8');
const ORIGIN = 'https://lia.test';

let fails = 0;
function ok(label, got, want) {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`);
}

const day = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const key = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

const L = (serial, o = {}) => Object.assign({
  serial_num: serial, serial_key: key(serial), inspection_date: day(-10), next_due_date: day(355),
  tech_name: 'Nate Dobbs', rep_number: '763', verified_by: 'Batavia', work_order_id: '98378',
  brand: 'Werner', type: 'Step', length: '6', public_ref: 'REF' + key(serial).slice(-7).padStart(7, '0'),
  notes: null, destroyed: false, destroy_reason: null, tag_label: null, tag_label_key: null }, o);
const F = (serial, o = {}) => Object.assign({
  serial_num: serial, serial_key: key(serial), public_ref: 'FPR' + key(serial).slice(-7).padStart(7, '0'),
  tag_label: null, tag_label_key: null, inspection_date: day(-20), next_due_date: day(345),
  tech_name: 'Nate Dobbs', rep_number: '763', verified_by: 'Batavia', manufacturer: 'BUCKINGHAM', model: 'U68',
  item_type: 'Body harness', status: 'pass', overall_pass: true, discard_reason: null, work_order_id: '98378',
  mfg_month: 3, mfg_year: 2024, lot_number: null, description: null }, o);

const LADDERS = [
  L('1000115', { public_ref: 'SHJM3W0P8C', work_order_id: '99287', inspection_date: day(-12), next_due_date: day(353) }),
  L('1135318', { destroyed: true, destroy_reason: 'Cut and destroyed: repair cost prohibitive', next_due_date: day(355) }),
  L('1345802', { inspection_date: day(-10), next_due_date: day(355) }),
  L('1345802', { inspection_date: day(-375), next_due_date: day(-10), work_order_id: '91000' }),
  L('2000001', { next_due_date: day(10) }),
  L('2000002', { next_due_date: day(-3) }),
  L('55555',   { work_order_id: '70000' }),
  L('3000001', { work_order_id: '55555' }),
  L('4000001', { work_order_id: '70001', notes: '<img src=x onerror="window.__xss=1">', brand: '<b>bold</b>',
                 tag_label: 'LT-77', tag_label_key: 'LT77' }),
  L('5000001', { work_order_id: 'unknown' }),
];
const FPS = [
  F('498418', { tag_label: 'FP146222', tag_label_key: 'FP146222', public_ref: 'J17JK0N9B5' }),
  F('FP158404', { status: 'fail', overall_pass: false, item_type: 'Climbing belt', model: '160N',
                  discard_reason: 'Failed: labels not legible', public_ref: 'XX42QZCN0L' }),
];
const CHECKS = [
  { public_ref: 'XX42QZCN0L', inspection_date: day(-20), ord: 1, prompt: 'Are all labels legible?', result: false, answer_label: 'No' },
  { public_ref: 'XX42QZCN0L', inspection_date: day(-20), ord: 2, prompt: 'Has the impact indicator been activated?', result: true, answer_label: 'No' },
];

// A training account's rows (migration 41): never in the public views, served
// only by the preview RPCs, and only for the right token.
const TOKEN = 'ab'.repeat(32);
const TRAIN_LADDERS = [
  L('BDEMO-01', { work_order_id: '99999', tech_name: 'Training lead', rep_number: 'TRAIN', verified_by: 'Training: Batavia demo', public_ref: 'TRN0000001' }),
  L('1000115', { work_order_id: '99999', destroyed: true, destroy_reason: 'Cut and destroyed: repair cost prohibitive',
                 rep_number: 'TRAIN', public_ref: 'TRN0000002' }),
];

// ── A stand-in for PostgREST: just the filters the page uses ──────────────────
const state = { pre40: false, down: false, views: [], requests: [] };
function filter(rows, params) {
  return rows.filter(r => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (k === 'or') {
        const terms = v.replace(/^\(|\)$/g, '').split(',').map(t => t.split('.eq.'));
        if (!terms.some(([c, val]) => String(r[c] ?? '') === val)) return false;
      } else if (v.startsWith('eq.')) {
        if (String(r[k] ?? '') !== v.slice(3)) return false;
      } else if (v.startsWith('in.(')) {
        const vals = [...v.slice(4, -1).matchAll(/"([^"]*)"/g)].map(m => m[1]);
        if (!vals.includes(String(r[k] ?? ''))) return false;
      }
    }
    return true;
  });
}
async function api(route) {
  const req = route.request(), u = new URL(req.url());
  const view = u.pathname.replace('/rest/v1/', '');
  state.requests.push(view + '?' + u.searchParams.toString());
  if (view === 'rpc/record_certificate_view') {
    state.views.push(JSON.parse(req.postData()).p);
    return route.fulfill({ status: 204, body: '' });
  }
  if (state.down) return route.fulfill({ status: 503, body: '{}' });
  const params = [...u.searchParams.entries()];
  let rows;
  if (view === 'ladder_inspections_public') {
    if (state.pre40 && params.some(([k, v]) => k === 'or' && v.includes('tag_label_key'))) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"code":"42703","message":"column ladder_inspections_public.tag_label_key does not exist"}' });
    }
    rows = state.pre40 ? LADDERS.map(({ destroyed, destroy_reason, tag_label, tag_label_key, ...r }) => r) : LADDERS;
  } else if (view === 'fall_protection_public') rows = FPS;
  else if (view === 'fall_protection_checks_public') rows = CHECKS;
  else if (view.startsWith('rpc/training_')) {
    const token = u.searchParams.get('p_token');
    const ps = params.filter(([k]) => k !== 'p_token');
    const mine = token === TOKEN;
    rows = view === 'rpc/training_ladder_inspections' && mine ? TRAIN_LADDERS : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filter(rows, ps)) });
  }
  else return route.fulfill({ status: 404, body: '{}' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filter(rows, params)) });
}

const browser = await chromium.launch();
async function open(urlPath, viewport = { width: 1100, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route('https://bqoxpbjtqwicurmuxueq.supabase.co/rest/v1/**', api);
  await page.route(ORIGIN + '/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  // The real scanner library, so its integrity hash is checked too.
  await page.goto(ORIGIN + urlPath);
  page.errors = errors;
  return page;
}
const settle = p => p.waitForFunction(() => !document.querySelector('#msg .spin'), null, { timeout: 5000 }).then(() => p.waitForTimeout(60));
async function find(p, q) { await p.fill('#q', q); await p.click('#btn-go'); await settle(p); }
// Text as a person reads it: every text node, with a space between elements
// (textContent runs "Next due" into "Not applicable").
const words = e => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); const out = [];
  while (w.nextNode()) out.push(w.currentNode.nodeValue); return out.join(' ').replace(/\s+/g, ' ').trim(); };
const text = (p, sel) => p.$eval(sel, (e, src) => (0, eval)('(' + src + ')')(e), words.toString()).catch(() => null);

// ── Home ─────────────────────────────────────────────────────────────────────
let p = await open('/');
ok('home: the search box is there and empty', await p.inputValue('#q'), '');
ok('home: no result yet', await p.$eval('#result', e => e.children.length), 0);
ok('home: the help explains all six results',
   await p.$$eval('.legend .lg', ls => ls.map(l => l.querySelector('.pill').textContent.replace(/^\S+\s/, ''))),
   ['Valid', 'Due soon', 'Overdue', 'Failed', 'Destroyed', 'No record']);
ok('home: and how to get a whole job', /work order number/i.test(await text(p, '#help')), true);

// ── A serial, typed loosely ──────────────────────────────────────────────────
await find(p, ' 13-45802 ');
ok('a hyphenated serial finds the ladder', await text(p, '#cert .serial'), '1345802');
ok('valid, with the next date', /^Valid — next inspection/.test(await text(p, '#cert .state')), true);
ok('what to do is said plainly', (await text(p, '#todo')).startsWith('OK to use'), true);
ok('the earlier inspection is listed', await p.$$eval('.hist .row', r => r.length), 1);
ok('its latest, not its oldest, decides the status (the old one is overdue)', await p.$eval('#cert .hero', e => e.className), 'hero t-ok');
ok('the address bar now holds a shareable link to it', new URL(p.url()).searchParams.get('t'), 'REF1345802');
ok('an outside visit is counted, as a typed serial',
   [state.views.at(-1).kind, state.views.at(-1).found, state.views.at(-1).lookup_by], ['ladder', true, 'serial']);

// ── Destroyed ────────────────────────────────────────────────────────────────
await find(p, '1135318');
ok('a destroyed ladder says destroyed, however far off its due date', await text(p, '#cert .state'), 'Destroyed — not in service');
ok('with the banner and the reason', await text(p, '#cert .banner'), 'DESTROYED — DO NOT USE Cut and destroyed: repair cost prohibitive');
ok('and "do not use"', (await text(p, '#todo')).startsWith('Do not use'), true);
ok('no next-due date is offered for it', /Next due Not applicable/.test(await text(p, '#cert .facts')), true);

// ── Due soon / overdue ───────────────────────────────────────────────────────
await find(p, '2000001');
ok('due within 30 days is "due", still usable', [await text(p, '#cert .state'), (await text(p, '#todo')).startsWith('OK to use — book')],
   ['Inspection due in 10 days', true]);
await find(p, '2000002');
ok('past due is overdue — out of use until re-inspected, but not "failed"',
   [await text(p, '#cert .state'), (await text(p, '#todo')).startsWith('Take it out of use'), await p.$('#cert .banner')],
   ['Inspection overdue by 3 days', true, null]);

// ── Fall protection ──────────────────────────────────────────────────────────
await find(p, 'fp 158404');
ok('a failed harness: removed from service', await text(p, '#cert .state'), 'Failed — removed from service');
ok('with its reason on the banner', /Failed: labels not legible/.test(await text(p, '#cert .banner')), true);
await p.waitForSelector('#checks:not([hidden])');
ok('its checks, verdict mark and the answer as given',
   await p.$$eval('#checks .chk', cs => cs.map(c => [c.querySelector('.mk').className.split(' ')[1], c.querySelector('.chk-ans').textContent])),
   [['fail', 'NO'], ['pass', 'NO']]);
ok('the inverted impact-indicator question reads NO with a pass mark — not "PASS"', true, true);

await find(p, 'fp146222');
ok('a tag number finds the item it is on', await text(p, '#cert .serial'), '498418');
ok('… and the visit is recorded as by tag number', state.views.at(-1).lookup_by, 'tag_label');
ok('… and shown on the record', /Tag number FP146222/.test(await text(p, '#cert .facts')), true);

await find(p, 'lt-77');
ok('a ladder tag number finds the ladder (migration 40)', await text(p, '#cert .serial'), '4000001');
ok('markup from the database is shown as text, never run',
   [await p.evaluate(() => window.__xss || null), /<img src=x/.test(await text(p, '#cert .facts')), await p.$('#cert .facts b')],
   [null, true, null]);

// ── Work order ───────────────────────────────────────────────────────────────
await find(p, '98378');
ok('a work order opens the job report', await text(p, '#wo-report .serial'), '98378');
ok('it counts ladders and FP items', /4 ladders and 2 fall-protection items inspected/.test(await text(p, '#wo-report .wo-head')), true);
ok('removed from service is listed first, with reasons',
   await p.$$eval('#removed .r', rs => rs.map(r => [r.querySelector('.mono').textContent, r.querySelector('.why').textContent])),
   [['1135318', 'Cut and destroyed: repair cost prohibitive'], ['FP158404', 'Failed: labels not legible']]);
ok('the table runs worst first',
   await p.$$eval('#wo-report tbody tr', rs => rs.map(r => r.dataset.st)),
   ['destroyed', 'failed', 'overdue', 'due', 'valid', 'valid']);
ok('tallies by result', await p.$$eval('#wo-report .tile', ts => ts.map(t => [...t.children].map(c => c.textContent).join(' '))),
   ['6 All items', '1 Destroyed', '1 Failed', '1 Overdue', '1 Due soon', '2 Valid']);
await p.click('#wo-report .tile[data-f="destroyed"]');
ok('tapping a tally filters the list', await p.$$eval('#wo-report tbody tr:not([hidden])', rs => rs.map(r => r.querySelector('.mono').textContent)), ['1135318']);
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#btn-csv')]);
const csv = fs.readFileSync(await dl.path(), 'utf8');
ok('the spreadsheet has every item, not just the filtered ones', csv.trim().split(/\r\n/).length, 7);
ok('and says which ladder was destroyed, and why',
   csv.split(/\r\n/).find(l => l.includes('1135318')).includes('Destroyed,Cut and destroyed: repair cost prohibitive'), true);
ok('it is named after the job', dl.suggestedFilename(), 'work-order-98378-inspections.csv');
await p.click('#wo-report .tile[data-f="all"]');
ok('"All items" brings every row back', await p.$$eval('#wo-report tbody tr:not([hidden])', rs => rs.length), 6);
await p.click('#wo-report tbody tr[data-st="failed"]');
ok('a row opens its record', await text(p, '#cert .serial'), 'FP158404');
await p.goBack(); await settle(p);
ok('Back returns to the job', await text(p, '#wo-report .serial'), '98378');

await find(p, 'WO-98378');
ok('"WO-" typed in front still finds the job', await text(p, '#wo-report .serial'), '98378');
await find(p, 'unknown');
ok('"unknown" is not a job — 1,724 unmatched records are not dumped on a customer', await text(p, '#result .state'), 'No inspection on record');

await find(p, '55555');
ok('a number that is both a serial and a job asks which',
   await p.$$eval('#result .choice', cs => cs.map(c => c.querySelector('span span').textContent)), ['55555', 'Work order 55555']);
await p.click('#result .choice[data-wo]');
ok('and opens the one chosen', await text(p, '#wo-report .serial'), '55555');

// ── Not found ────────────────────────────────────────────────────────────────
const before = state.views.length;
await find(p, 'DEMO2026');
ok('an unknown number says so', await text(p, '#result .state'), 'No inspection on record');
ok('and what to check before deciding', await p.$$eval('#result .tips li', l => l.length), 4);
ok('and never offers a status', await p.$('#result .pill'), null);
ok('a miss is recorded too', [state.views.length - before, state.views.at(-1).found], [1, false]);
ok('no page errors', p.errors, []);
await p.close();

// ── Old links ────────────────────────────────────────────────────────────────
p = await open('/?t=SHJM3W0P8C'); await settle(p);
ok('a ladder tag link (/?t=) opens its certificate', await text(p, '#cert .serial'), '1000115');
ok('and counts as a tag scan', state.views.at(-1).lookup_by, 'ref');
await p.close();

state.views.length = 0;
p = await open('/fp/?t=GONE000000&s=498418'); await settle(p);
ok('/fp/ tag whose code no longer resolves falls back to the serial in it', await text(p, '#cert .serial'), '498418');
ok('one visit recorded, the find — not a miss for the stale code',
   state.views.map(v => [v.kind, v.found]), [['fall_protection', true]]);
await p.close();

p = await open('/?serial=1000115'); await settle(p);
ok('?serial= still works', await text(p, '#cert .serial'), '1000115');
await p.close();
p = await open('/?wo=99287'); await settle(p);
ok('?wo= still works', await text(p, '#wo-report .serial'), '99287');
await p.close();

state.views.length = 0;
p = await open('/fp/?t=XX42QZCN0L&src=app'); await settle(p);
ok('?src=app shows the certificate', await text(p, '#cert .serial'), 'FP158404');
ok('but records no visit — Lia\'s own apps are not customers', state.views.length, 0);
ok('and keeps src=app as you move around', new URL(p.url()).searchParams.get('src'), 'app');
await p.close();

// ── Scanned codes ────────────────────────────────────────────────────────────
p = await open('/');
ok('a scanned tag URL is read for its code, not searched as text',
   await p.evaluate(() => [fromScan('https://lia.mobileappdevelopmentgroup.com/fp/?t=XX42QZCN0L&s=FP158404'), fromScan(' 1345802 ')]),
   [{ q: 'XX42QZCN0L', s: 'FP158404', by: 'ref' }, { q: '1345802', by: 'serial' }]);
await p.close();

// ── Before migration 40 is live ──────────────────────────────────────────────
state.pre40 = true;
p = await open('/');
await find(p, '1000115');
ok('pre-40: ladders are still found (the tag column is dropped from the search)', await text(p, '#cert .serial'), '1000115');
await find(p, '1135318');
ok('pre-40: with no destroyed column the ladder reads as its dates say', await text(p, '#cert .state') !== null, true);
ok('pre-40: no page errors', p.errors, []);
await p.close();
state.pre40 = false;

// ── The database is unreachable ──────────────────────────────────────────────
state.down = true;
p = await open('/');
await find(p, '1000115');
ok('an outage is an outage — never "not found"',
   [await p.$eval('#msg', e => e.className), /Couldn.t reach/.test(await text(p, '#msg')), await p.$('#result .state')],
   ['msg err vis', true, null]);
state.down = false;
await p.click('#btn-retry'); await settle(p);
ok('Try again recovers once it is back', await text(p, '#cert .serial'), '1000115');
await p.close();

// ── Training preview (migration 41) ──────────────────────────────────────────
state.views.length = 0; state.requests.length = 0;
p = await open('/?preview=' + TOKEN + '&wo=99999'); await settle(p);
ok('preview: the TEST bar is up', await p.$eval('#preview-bar', e => !e.hidden && /TEST CERTIFICATES/.test(e.textContent)), true);
ok('preview: the training job is listed', /BDEMO-01/.test(await text(p, '#result') || ''), true);
ok('preview: and the certificates are watermarked TEST',
   await p.$eval('#result', e => getComputedStyle(e, '::after').content.includes('NOT A REAL CERTIFICATE')), true);
ok('preview: nothing was asked of the public views',
   state.requests.filter(r => /^(ladder_inspections|fall_protection)/.test(r)).length, 0);
await find(p, '1000115');
ok('preview: a real serial shows the TRAINING copy, destroyed — never the real record',
   await text(p, '#cert .serial') === '1000115' && /Destroyed/.test(await text(p, '#result') || ''), true);
ok('preview: the address keeps the token as you search',
   await p.evaluate(() => new URL(location.href).searchParams.get('preview')), TOKEN);
ok('preview: no visit is recorded', state.views.length, 0);
ok('preview: no page errors', p.errors, []);
await p.close();

p = await open('/?preview=' + 'cd'.repeat(32) + '&wo=99999'); await settle(p);
ok('preview: a wrong token finds nothing', /BDEMO-01/.test(await text(p, '#result') || ''), false);
await p.close();

p = await open('/?preview=nope&s=BDEMO-01'); await settle(p);
ok('a malformed token is ignored: no TEST bar', await p.$eval('#preview-bar', e => e.hidden), true);
ok('… and the public site never shows a training item', /No record|not found/i.test(await text(p, '#result') || ''), true);
await p.close();

// ── A phone ──────────────────────────────────────────────────────────────────
for (const urlPath of ['/', '/?wo=98378', '/?t=XX42QZCN0L']) {
  p = await open(urlPath, { width: 375, height: 780 }); await settle(p);
  ok(`phone width, ${urlPath}: nothing runs off the side`,
     await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  ok(`phone width, ${urlPath}: no page errors`, p.errors, []);
  await p.close();
}

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nAll certificate site assertions passed.');
process.exit(fails ? 1 : 0);
