// The How To screen. Run with `npm run test:desktop`.
//
// It exists because the order of operations is not guessable: a CSV and field
// work take different routes, merging several techs has rules that decide
// things for you, and an import that finishes is not an import that put
// everything on the work order.
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

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));

await p.addInitScript(() => {
  window.__sent = [];
  window.api = {
    isSupabaseConfigured: async () => true,
    getSession: async () => ({ user: { email: 'office@batavia.test' }, credits: -1 }),
    getContext: async () => ({ ok: true, ctx: { role: 'lead', is_umbrella: true, acting_is_umbrella: true,
                                                impersonating: false, can_act_as: [] } }),
    supportAmIDeveloper: async () => ({ ok: true, developer: false }),
    supportCounts: async () => ({ ok: true, counts: {} }),
    supportSubmit: async (t) => { window.__sent.push(t); return { ok: true, ticket: { id: 't1' } }; },
    onLog(){}, onWaitingForReady(){}, onDiff(){}, onComplete(){}, onError(){}, onExited(){},
    onCreditOk(){}, onPreflight(){}, onBillingWarning(){}, onCreditError(){}, onPaused(){}, onResumed(){},
    onFpPushLog(){}, onFpPushWaiting(){}, onFpPushPushed(){}, onFpPushComplete(){},
    onFpPushError(){}, onFpPushExited(){},
  };
});
await p.goto(BASE + '/index.html');
await p.waitForTimeout(400);

// Readable without signing in: somebody working out whether they can use this
// at all should not have to log in first.
await p.click('#home-help');
await p.waitForTimeout(250);
ok('the How To screen opens', await p.evaluate(() => $('screen-help').classList.contains('active')), true);

const text = await p.$eval('#screen-help', e => e.textContent);
ok('it covers a CSV from one tech', /Choose CSV/.test(text), true);
ok('and field work with no CSV at all', /No CSV, no email/.test(text), true);
ok('and several techs on one work order', /Several techs on one work order/.test(text), true);
ok('it states the rule that decides conflicts', /FAIL always beats a PASS/.test(text), true);
ok('it tells a lead to check the work afterwards', /Check the work after every import/.test(text), true);
ok('and says what a skipped ladder means', /which ladders\s+were skipped/.test(text.replace(/\s+/g, ' ')) || /were skipped/.test(text), true);
ok('and that running again is safe', /never adds a second copy/.test(text), true);

// ── Filing an issue ─────────────────────────────────────────────────────────
await p.click('#btn-help-send'); await p.waitForTimeout(150);
ok('an empty report is refused', await p.$eval('#help-msg', e => /what happened/i.test(e.textContent)), true);
ok('and nothing was sent', await p.evaluate(() => window.__sent.length), 0);

await p.selectOption('#help-kind', 'Feature request');
await p.fill('#help-subject', 'A way to reprint a certificate');
await p.fill('#help-body', 'Customer lost the tag and wants another copy.');
await p.click('#btn-help-send'); await p.waitForTimeout(250);
ok('a report carries what it is', await p.evaluate(() => window.__sent[0].subject),
   'Feature request: A way to reprint a certificate');
ok('and what happened', await p.evaluate(() => window.__sent[0].body),
   'Customer lost the tag and wants another copy.');
ok('the screen confirms it', await p.$eval('#help-msg', e => /Sent/.test(e.textContent)), true);
ok('and clears the form', await p.evaluate(() => $('help-subject').value), '');

ok('no page errors', errs, []);

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll How To assertions passed.');
process.exit(fails ? 1 : 0);
