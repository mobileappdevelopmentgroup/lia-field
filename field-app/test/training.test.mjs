// Training accounts on the phone (training.js, migration 41).
//
// The server keeps training off the public certificates; the phone's job is
// to say so, loudly, and to open the account's own certificates. Pinned here:
//   * a real account shows no bar, and gets no preview link;
//   * a training account shows the bar on every screen, with a link to its
//     certificates carrying the preview token and its training work order;
//   * the answer survives a failed fetch, and is gone after sign-out.
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('config.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ supabase: { url: 'https://x.supabase.co', anonKey: 'k' } }));
  }
  const file = path.join(ROOT, 'field-app', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(ROOT, 'field-app')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port;

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const TOKEN = 'f'.repeat(64);
const stub = `
window.__ctx = { account_name: 'Nate', is_training: false };
window.__down = sessionStorage.getItem('__down') === '1';
window.supabase = { createClient: function () { return {
  auth: {
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1', email: 't@x' } } } }); },
    signOut: function () { return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function (fn) {
    if (fn === 'my_context') return Promise.resolve(window.__down ? { data: null, error: { message: 'offline' } }
                                                               : { data: window.__ctx, error: null });
    if (fn === 'account_snapshot_meta') return Promise.resolve({ data: { total: 0, changed: 0, next_since: null }, error: null });
    if (fn === 'account_snapshot') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  },
}; } };`;

const b = await chromium.launch();
const ctx = await b.newContext();
await ctx.route(/supabase-js@2/, r => r.fulfill({ status: 200, contentType: 'text/javascript',
  headers: { 'cache-control': 'no-store' }, body: stub }));
await ctx.route(/zxing-browser/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.ZXingBrowser={};' }));
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(BASE + '/index.html');
await p.waitForTimeout(600);

await p.evaluate(() => LiaTraining.refresh());
ok('a real account shows no training bar', await p.$('#training-bar') === null, true);
ok('and has no preview link', await p.evaluate(() => LiaTraining.previewUrl()), '');

await p.evaluate((t) => { window.__ctx = { account_name: 'Training crew: Batavia demo', is_training: true,
  training_preview_token: t, training_bsi_work_orders: ['99999'] }; }, TOKEN);
await p.evaluate(() => LiaTraining.refresh());
ok('a training account shows the bar', await p.$eval('#training-bar', e => /TRAINING ACCOUNT/.test(e.textContent)), true);
ok('its link opens the account\'s certificates by preview token, on its training work order',
   await p.$eval('#training-certs', e => e.href),
   `https://lia.mobileappdevelopmentgroup.com/?preview=${TOKEN}&wo=99999&src=app`);
ok('the bar sits above every screen, not inside one',
   await p.evaluate(() => document.body.firstElementChild.id), 'training-bar');
ok('and the topbar beneath gives up the notch padding',
   await p.evaluate(() => document.body.classList.contains('is-training')), true);

await p.evaluate(() => { window.__down = true; });
await p.evaluate(() => LiaTraining.refresh());
ok('with no signal it keeps the last answer', await p.$('#training-bar') !== null, true);
await p.evaluate(() => { window.__down = false; });

// Restarted with no signal: the bar must come back from the cache alone.
await p.evaluate(() => sessionStorage.setItem('__down', '1'));
await p.reload(); await p.waitForTimeout(600);
ok('it is still there after a restart, before any fetch', await p.$('#training-bar') !== null, true);

await p.evaluate(() => { sessionStorage.removeItem('__down'); window.__down = false; });
await p.evaluate(() => LiaSync.signOut()); await p.waitForTimeout(200);
ok('sign-out takes it away', await p.$('#training-bar') === null, true);
ok('and forgets the token', await p.evaluate(() => localStorage.getItem('lia-training')), null);

console.log(errs.length ? 'page errors: ' + errs.join(' | ') : '\npage errors: none');
if (errs.length) fails++;
await b.close(); server.close();
console.log(fails ? `RESULT: ${fails} failed` : 'RESULT: all passed');
process.exit(fails ? 1 : 0);
