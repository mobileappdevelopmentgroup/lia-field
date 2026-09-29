// Handing a job's CSV to somebody.
//
// Reported from the Play build: "save csv in android app is not working". It
// did nothing at all — no file, no error, no share sheet. Android's WebView
// implements neither of the two browser routes the button relied on: the Web
// Share API is a Chrome feature rather than a WebView one, and a WebView has
// no download manager, so `<a download>` clicks through to nothing. iOS has
// Web Share in WKWebView, which is why the same button worked on the iPhone
// and hid the problem for weeks.
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

const STUB = `
window.supabase = { createClient: function () { return {
  auth: {
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1' } } } }); },
    signInWithPassword: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function (fn) {
    // One catalogue row, so the first-sync gate is satisfied and a job will
    // open — that gate itself is tested in boot.test.mjs.
    if (fn === 'account_snapshot_meta') return Promise.resolve({ data: { total: 1, changed: 1, next_since: '2026-01-01T00:00:00Z' }, error: null });
    if (fn === 'account_snapshot') return Promise.resolve({ data: window.__snapDone ? [] : (window.__snapDone = true, [
      { asset_id: 'a1', serial_raw: 'L-1', serial_key: 'L1', kind: 'ladder', is_deleted: false, updated_at: '2026-01-01T00:00:00Z' }
    ]), error: null });
    if (fn === 'my_jobs') return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  },
}; } };`;

const b = await chromium.launch();

// A handset: Capacitor present, and neither browser route available — exactly
// what the Android WebView looks like from inside the page.
async function openNative(failWith) {
  const ctx = await b.newContext();
  await ctx.addInitScript(`
    window.__fs = []; window.__shared = []; window.__anchorClicks = 0;
    window.Capacitor = {
      isNativePlatform: function () { return true; },
      Plugins: {
        Filesystem: { writeFile: function (o) {
          window.__fs.push(o);
          ${failWith ? `return Promise.reject(new Error(${JSON.stringify(failWith)}));` : ''}
          return Promise.resolve({ uri: 'file:///cache/' + o.path });
        } },
        Share: { share: function (o) { window.__shared.push(o); return Promise.resolve(); } },
      },
    };
    delete navigator.canShare; delete navigator.share;
    // Catch the web fallback actually firing, which on a handset means the
    // file went nowhere.
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__anchorClicks++;
      return realClick.apply(this, arguments);
    };
  `);
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
  return { p, ctx, errs };
}

// The app seeds a demo job; open it and put a ladder in it so there is
// something to export. A job will not open until the catalogue has come down
// once, so satisfy that gate first — it is tested in boot.test.mjs.
async function openSeededJob(p) {
  await p.evaluate(() => LiaSync.pullCatalog({}));
  await p.reload();
  await p.waitForTimeout(700);
  await p.evaluate(() => { LiaSyncState.forgetSyncing(); return LiaSyncState.syncing(); });
  await p.evaluate(() => {
    const all = loadJobs();
    const id = Object.keys(all)[0];
    all[id].ladders = [{ serialNum: '1719761', brand: 'Werner', type: 'Extension',
                         length: '24', parts: [{ name: 'G13', qty: 2 }] }];
    saveJobs(all);
    openJob(id);
  });
  await p.waitForTimeout(300);
}

// ── On a handset the file goes through Capacitor ────────────────────────────
let { p, ctx, errs } = await openNative(null);
await openSeededJob(p);
await p.click('#btn-share-csv');
await p.waitForTimeout(400);

ok('the CSV is written to the device', await p.evaluate(() => window.__fs.length), 1);
ok('as a .csv named after the job',
   await p.evaluate(() => /\.csv$/.test(window.__fs[0].path)), true);
ok('with the rows in it, not an empty file',
   await p.evaluate(() => /1719761/.test(window.__fs[0].data)), true);
ok('and it is handed to the system share sheet',
   await p.evaluate(() => window.__shared.length), 1);
ok('pointing at the file that was just written',
   await p.evaluate(() => window.__shared[0].files[0] === 'file:///cache/' + window.__fs[0].path), true);
ok('the web download is NOT used — on a WebView it does nothing',
   await p.evaluate(() => window.__anchorClicks), 0);
ok('no page errors', errs, []);
await p.close(); await ctx.close();

// ── A failure is said out loud ──────────────────────────────────────────────
// The whole complaint was a button that looked like it worked. Failing
// silently again would be the same bug wearing a different hat.
({ p, ctx, errs } = await openNative('No space left on device'));
await openSeededJob(p);
await p.click('#btn-share-csv');
await p.waitForTimeout(400);
ok('a write that fails is reported to the tech',
   await p.$eval('#save-status', e => /could not save the csv/i.test(e.textContent)), true);
ok('and names the reason',
   await p.$eval('#save-status', e => /no space left/i.test(e.textContent)), true);
ok('nothing is claimed to have been shared',
   await p.evaluate(() => window.__shared.length), 0);
ok('no page errors', errs, []);
await p.close(); await ctx.close();

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll CSV hand-off assertions passed.');
process.exit(fails ? 1 : 0);
