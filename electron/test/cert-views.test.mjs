// The certificate views screen. Run with `npm run test:desktop`.
//
// The report is only as meaningful as the network labels — an unlabelled
// network reads as "unknown" and tells nobody anything — so the two live on one
// screen and both are tested together.
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

const SUMMARY = {
  since: '2026-07-30T00:00:00Z',
  by_viewer: [
    { viewer_kind: 'office', network_label: 'Batavia office', hits: 42, sessions: 12, items: 9 },
    { viewer_kind: 'field', network_label: null, hits: 17, sessions: 15, items: 15 },
    { viewer_kind: 'unknown', network_label: null, hits: 3, sessions: 3, items: 3 },
  ],
  by_day: [
    { day: '2026-08-27', hits: 4 }, { day: '2026-08-28', hits: 11 }, { day: '2026-08-29', hits: 2 },
  ],
  top_items: [
    { public_ref: 'B7K2M9QRXZ', serial_num: 'FP158354', kind: 'fall_protection',
      hits: 9, last_viewed: '2026-08-29T10:00:00Z' },
  ],
  misses: [
    { public_ref: 'ZZZZZZZZZZ', serial_key: null, hits: 2, last_seen: '2026-08-28T09:00:00Z' },
  ],
};

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript((summary) => {
  window.__calls = [];
  window.__networks = [
    { id: 'n1', cidr: '198.51.100.0/24', label: 'Batavia office', kind: 'office' },
  ];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    viewsSummary: async (days) => { window.__calls.push(['summary', days]); return { ok: true, summary }; },
    viewsNetworks: async () => ({ ok: true, networks: window.__networks }),
    viewsSaveNetwork: async (net) => { window.__calls.push(['save', net]);
      window.__networks = window.__networks.concat([{ id: 'n2', ...net }]); return { ok: true }; },
    viewsDeleteNetwork: async (id) => { window.__calls.push(['del', id]);
      window.__networks = window.__networks.filter(n => n.id !== id); return { ok: true }; },
    viewsMyNetwork: async () => ({ ok: true, network: { suggested_cidr: '203.0.113.0/24' } }),
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
  };
}, SUMMARY);

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);
// Certificate Views is not a card on the home screen any more — it is one of
// the screens buried under Advanced, because it is not part of a normal day.
await p.click('#home-advanced'); await p.waitForTimeout(200);
await p.click('#adv-views'); await p.waitForTimeout(400);

ok('the views screen opens', await p.evaluate(() => $('screen-views').classList.contains('active')), true);
// 30 days is the default because it is the window a monthly conversation uses.
ok('defaulting to 30 days', await p.evaluate(() => window.__calls[0][1]), 30);

// The headline question: office or field.
const who = await p.$eval('#views-who', e => e.textContent.replace(/\s+/g, ' '));
ok('office views are labelled by network name', /Office Batavia office 42/.test(who), true);
ok('field views show without inventing a network name', /Field — 17/.test(who), true);
// An unlabelled network must read as unknown rather than being guessed into a
// bucket, or the report quietly becomes fiction.
ok('and an unlabelled network reads as unknown', /Unknown network/.test(who), true);

ok('a bar per day is drawn', await p.$$eval('.vw-bar', e => e.length), 3);
// Relative heights, so the shape of the trend is visible rather than three
// identical blocks.
ok('scaled to the busiest day',
   await p.$$eval('.vw-bar', e => e.map(x => x.style.height)), ['17px', '46px', '8px']);

const body = await p.$eval('#views-body', e => e.textContent);
ok('the most-looked-at items are listed', /FP158354/.test(body), true);
ok('with the certificate code', /B7K2M9QRXZ/.test(body), true);
// Each of these is a physical tag in the world that resolves to no record —
// the most actionable thing on the screen.
ok('and tags pointing at nothing are called out', /Tags pointing at nothing/.test(body), true);
ok('with the code somebody actually scanned', /ZZZZZZZZZZ/.test(body), true);

// Without a named network the whole report is "unknown", so labelling one has
// to be right here rather than buried in settings.
ok('named networks are listed', await p.$$eval('#views-networks .vw-row', e => e.length), 1);
// A lead cannot look up what his office looks like from the server's side.
ok('and this machine is offered as a starting point',
   await p.$eval('#vw-mine', e => /203\.0\.113\.0\/24/.test(e.textContent)), true);
await p.click('#vw-mine'); await p.waitForTimeout(150);
ok('clicking it fills the box', await p.$eval('#vw-cidr', e => e.value), '203.0.113.0/24');

// Both halves are required: a range with no name is not a label.
await p.fill('#vw-label', '');
await p.click('#btn-vw-add'); await p.waitForTimeout(200);
ok('a network with no name is refused',
   await p.$eval('#views-msg', e => /needs both/i.test(e.textContent)), true);
ok('and nothing was saved', await p.evaluate(() => window.__calls.filter(c => c[0] === 'save').length), 0);

await p.fill('#vw-label', 'Warehouse wifi');
await p.selectOption('#vw-kind', 'field');
await p.click('#btn-vw-add'); await p.waitForTimeout(300);
ok('a complete network is saved',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'save').pop()[1]),
   { cidr: '203.0.113.0/24', label: 'Warehouse wifi', kind: 'field' });
// Labelling is not retroactive, and saying so avoids a support ticket.
ok('and the lead is told it is not retroactive',
   await p.$eval('#views-msg', e => /earlier ones keep/i.test(e.textContent)), true);
ok('the list picks it up', await p.$$eval('#views-networks .vw-row', e => e.length), 2);

await p.click('[data-views-days="7"]'); await p.waitForTimeout(300);
ok('the window is passed through',
   await p.evaluate(() => window.__calls.filter(c => c[0] === 'summary').pop()[1]), 7);

await p.click('.vw-del'); await p.waitForTimeout(300);
ok('a network can be removed', await p.$$eval('#views-networks .vw-row', e => e.length), 1);

// Network labels are free text and go into innerHTML.
ok('a label containing markup is escaped, not rendered',
   await p.evaluate(() => {
     renderViewsNetworks([{ id: 'x', cidr: '10.0.0.0/8', kind: 'office',
                            label: '<img src=x onerror=alert(1)>' }]);
     const el = document.querySelector('#views-networks .vw-row-label');
     return { imgs: document.querySelectorAll('#views-networks img').length,
              // The cidr follows on the next line, so match the start rather
              // than the whole string — <br> leaves no separator in textContent.
              startsWithRaw: el.textContent.trim().startsWith('<img src=x onerror=alert(1)>') };
   }), { imgs: 0, startsWithRaw: true });

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
