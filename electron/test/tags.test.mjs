// The Tags screen. Run with `npm run test:desktop`.
//
// What a lead needs from it: how many blank tags are left and which numbers,
// what every other tag is on, and which of those items failed. Plus the one
// rule that is about safety rather than display: a link is opened only through
// main's allowlist, never by the page itself.
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

const sheet = n => `https://docs.google.com/spreadsheets/d/${n}/edit?usp=drivesdk`;
const blank = n => ({ tag_label: 'FP' + n, tag_url: sheet('s' + n), account_name: 'Nate Dobbs',
  holder_name: 'Nate Dobbs', serial_num: null, overall_pass: null, certificate_url: null });
const TAGS = [
  { tag_label: 'FP161282', tag_url: sheet('a'), account_name: 'Nate Dobbs', holder_name: 'Nate Dobbs',
    serial_num: '8291761', item_type: 'SRL (self-retracting lifeline)', description: 'SUTHERLAND',
    last_inspected: '2026-05-25', overall_pass: false,
    certificate_url: 'https://lia.mobileappdevelopmentgroup.com/fp/?t=5MWPT8RXPL' },
  { tag_label: 'FP146221', tag_url: sheet('b'), account_name: 'Nate Dobbs', holder_name: 'Nate Dobbs',
    serial_num: '9203667', item_type: 'SRL (self-retracting lifeline)', description: 'ARMSTRONG',
    last_inspected: '2026-05-25', overall_pass: true,
    certificate_url: 'https://lia.mobileappdevelopmentgroup.com/fp/?t=QCLN1XXCGD' },
  { tag_label: 'FP161333', tag_url: sheet('c'), account_name: 'Nate Dobbs', holder_name: 'Nate Dobbs',
    serial_num: '976992', item_type: null, overall_pass: null, certificate_url: 'https://lia.mobileappdevelopmentgroup.com/fp/?t=NOCERT0000' },
  blank(161340), blank(161341), blank(161342), blank(146234), blank(165800),
].sort((a, z) => a.tag_label.localeCompare(z.tag_label));   // tag_stock_list() orders by label

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript((tags) => {
  window.__opened = [];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'lead@acme.com' }, credits: 5 }),
    tagsList: async () => ({ ok: true, tags }),
    openLink: async (url) => { window.__opened.push(url); return { ok: true }; },
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    loadHistory: async () => ({ ok: true, groups: [] }),
    fpListModels: async () => ({ ok: true, models: [] }),
    mergeWorkOrders: async () => ({ ok: true, workOrders: [] }),
  };
  // A page that opens windows itself would bypass main's allowlist.
  window.open = (u) => { window.__windowOpen = u; return null; };
}, TAGS);

await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);
ok('Tags is a card on the home screen', await p.$eval('#home-tags', e => e.offsetParent !== null), true);
await p.click('#home-tags'); await p.waitForTimeout(400);
ok('it opens the Tags screen', await p.evaluate(() => $('screen-tags').classList.contains('active')), true);

const stats = await p.$eval('#tags-stats', e => e.innerText.replace(/\s+/g, ' ').trim().toLowerCase());
ok('the counts lead: held, blank, on equipment, on failed items',
   stats, '8 tags held 5 blank 3 on equipment 1 on failed items');
ok('blank tags read as runs of numbers, not a list of hundreds',
   await p.$$eval('.tg-range', e => e.map(x => x.textContent)), ['FP146234', 'FP161340–FP161342', 'FP165800']);
ok('the list opens on the blank ones',
   await p.$$eval('#tags-tbl tr td.vw-mono', e => e.map(x => x.textContent)),
   ['FP146234', 'FP161340', 'FP161341', 'FP161342', 'FP165800']);

await p.click('[data-tags-filter="used"]'); await p.waitForTimeout(150);
const used = await p.$$eval('#tags-tbl tr', rows => rows.slice(1).map(r => r.textContent.replace(/\s+/g, ' ').trim()));
ok('on equipment, each tag names what it is on', used.some(r => /FP161282 Fail .*SRL .*8291761 SUTHERLAND/.test(r)), true);
ok('a failed item is marked as failed', used.some(r => /FP161282 Fail/.test(r)), true);
ok('a passed one as passed', used.some(r => /FP146221 Pass/.test(r)), true);
ok('an item with a tag and no certificate yet says so', used.some(r => /FP161333 No certificate/.test(r)), true);
ok('and the ranges step aside there', await p.$$eval('.tg-range', e => e.length), 0);

await p.fill('#tags-q', 'armstrong'); await p.waitForTimeout(150);
ok('search finds a tag by the item\'s location',
   await p.$$eval('#tags-tbl tr td.vw-mono', e => e.map(x => x.textContent)), ['FP146221']);
await p.fill('#tags-q', ''); await p.waitForTimeout(100);

await p.click('#tags-tbl [data-open*="5MWPT8RXPL"]'); await p.waitForTimeout(150);
await p.click('[data-tags-filter="blank"]'); await p.waitForTimeout(150);
await p.click('#tags-tbl [data-open*="s161340"]'); await p.waitForTimeout(150);
ok('links go through main, which decides what may be opened',
   await p.evaluate(() => window.__opened),
   ['https://lia.mobileappdevelopmentgroup.com/fp/?t=5MWPT8RXPL', 'https://docs.google.com/spreadsheets/d/s161340/edit?usp=drivesdk']);
ok('and the page never opens a window of its own', await p.evaluate(() => window.__windowOpen || null), null);
ok('one company means no company column',
   await p.$$eval('#tags-tbl th', e => e.map(x => x.textContent).includes('Company')), false);

await p.click('[data-tags-filter=""]'); await p.waitForTimeout(150);
ok('All shows every tag', await p.$$eval('#tags-tbl tr', r => r.length - 1), 8);

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
