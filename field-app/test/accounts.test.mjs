// Two techs, one phone.
//
// A phone gets handed over. Nothing here is about tidiness: uploading the last
// tech's queue under the next tech's sign-in files their work in the wrong
// company's account, under the wrong name, against the wrong job — and the
// first tech, signing back in that evening, finds it gone.
//
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

// A stub whose signed-in user can be swapped, the way signing out and back in
// swaps it on a real phone.
const STUB = `
window.__calls = [];
window.__user = { id: 'nate', email: 'nate@sub.test' };
window.supabase = { createClient: function () { return {
  auth: {
    getSession: function () {
      return Promise.resolve({ data: { session: window.__user ? { user: window.__user } : null } });
    },
    signInWithPassword: function (c) {
      window.__user = c.email === 'mike@sub.test'
        ? { id: 'mike', email: 'mike@sub.test' }
        : { id: 'nate', email: 'nate@sub.test' };
      return Promise.resolve({ data: { session: { user: window.__user } }, error: null });
    },
    signOut: function () { window.__user = null; return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function (fn, args) {
    window.__calls.push({ fn: fn, p: args && args.p, as: window.__user && window.__user.id });
    if (fn === 'account_snapshot_meta') return Promise.resolve({ data: { total: 1, changed: 1, next_since: '2026-01-01T00:00:00Z' }, error: null });
    if (fn === 'account_snapshot') return Promise.resolve({ data: window.__snap ? [] : (window.__snap = true, [
      { asset_id: 'a1', serial_raw: 'L-1', serial_key: 'L1', kind: 'ladder', is_deleted: false, updated_at: '2026-01-01T00:00:00Z' }
    ]), error: null });
    if (fn === 'my_jobs') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: 1, error: null });
  },
}; } };`;

const b = await chromium.launch();
const ctx = await b.newContext();
await ctx.route(/supabase-js@2/, r =>
  r.fulfill({ status: 200, contentType: 'text/javascript',
              headers: { 'cache-control': 'no-store' }, body: STUB }));
await ctx.route(/zxing-browser/, r =>
  r.fulfill({ status: 200, contentType: 'text/javascript',
              headers: { 'cache-control': 'no-store' }, body: 'window.ZXingBrowser={};' }));
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(BASE + '/index.html');
await p.waitForTimeout(700);

// ── Nate captures, offline, and hands the phone over ────────────────────────
await p.evaluate(() => {
  Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
  return LiaSync.rememberUser();
});
await p.evaluate(() => {
  LiaSync.enqueue({ clientId: 'nate-1', kind: 'ladder', payload: { serial_num: 'N-1', work_order_id: 'WO-N' } });
  const all = loadJobs();
  const id = crypto.randomUUID();
  all[id] = { id, name: "Nate's job", workOrderNum: 'WO-N', scope: 'ladder', ladders: [],
              items: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
              ownerId: 'nate', ownerEmail: 'nate@sub.test' };
  saveJobs(all);
});
ok('Nate has one record waiting', await p.evaluate(() => LiaSync.queueLength()), 1);

// ── Mike signs in on the same phone ─────────────────────────────────────────
await p.evaluate(() => LiaSync.signOut());
await p.evaluate(() => LiaSync.signIn('mike@sub.test', 'pw'));
await p.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); });
await p.evaluate(() => LiaSync.rememberUser());

const res = await p.evaluate(() => LiaSync.drain({}));
ok('Mike does not upload Nate\'s record', res.sent, 0);
ok('and it is still on the phone, not discarded',
   await p.evaluate(() => LiaSync.queueLength()), 1);
ok('nothing was sent to the server as Mike',
   await p.evaluate(() => window.__calls.filter(c => /record_inspection/.test(c.fn)).length), 0);

// Mike's own work goes up normally — being careful about Nate's must not stop
// the phone working for whoever is holding it.
await p.evaluate(() => {
  LiaSync.enqueue({ clientId: 'mike-1', kind: 'ladder', payload: { serial_num: 'M-1', work_order_id: 'WO-M' } });
});
const res2 = await p.evaluate(() => LiaSync.drain({}));
ok('Mike\'s own record uploads', res2.sent, 1);
ok('and Nate\'s is still waiting for him',
   await p.evaluate(() => LiaSync.queueLength()), 1);

// ── The jobs list says whose work is whose ──────────────────────────────────
await p.evaluate(() => { renderJobList(); });
await p.waitForTimeout(200);
ok('a job captured by somebody else is still listed',
   await p.$$eval('.job-card', els => els.some(e => /Nate's job/.test(e.textContent))), true);
ok('marked with the address that owns it',
   await p.$$eval('.job-owner', els => els.some(e => /nate@sub\.test/.test(e.textContent))), true);
ok('and said to upload under them, not whoever is signed in',
   await p.$$eval('.job-owner.other', els => els.some(e => /uploads when they sign in/.test(e.textContent))), true);

// ── Nate comes back ─────────────────────────────────────────────────────────
await p.evaluate(() => LiaSync.signOut());
await p.evaluate(() => LiaSync.signIn('nate@sub.test', 'pw'));
await p.evaluate(() => LiaSync.rememberUser());
const res3 = await p.evaluate(() => LiaSync.drain({}));
ok('his record goes up when he signs back in', res3.sent, 1);
ok('and the queue is finally empty', await p.evaluate(() => LiaSync.queueLength()), 0);
ok('sent as him', await p.evaluate(() =>
  window.__calls.filter(c => /record_inspection/.test(c.fn)).pop().as), 'nate');

ok('no page errors', errs, []);

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll shared-phone assertions passed.');
process.exit(fails ? 1 : 0);
