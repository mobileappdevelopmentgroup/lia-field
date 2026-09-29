// Which screen the app opens on, and the first-sync gate.
//
// Served over HTTP, not file://, because that is how the app actually runs —
// https on Pages, capacitor://localhost when packaged. fetch() does not work
// under file://, so a file:// harness would exercise the wrong path entirely.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png' };

let CONFIGURED = true;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('config.json')) {
    if (!CONFIGURED) { res.writeHead(404); return res.end(); }
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

// The page loads the real Supabase UMD from a CDN, which would overwrite a stub
// set beforehand — so the stub is served AS that script.
function stubScript(session) {
  const sess = session ? '{ user: { id: "u1" } }' : 'null';
  return [
    'window.supabase = { createClient: function () { return {',
    '  auth: {',
    '    getSession: function () { return Promise.resolve({ data: { session: ' + sess + ' } }); },',
    '    signInWithPassword: function () { return Promise.resolve({ data: { session: { user: { id: "u1" } } }, error: null }); },',
    '    signOut: function () { return Promise.resolve({}); },',
    '    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },',
    '  },',
    '  rpc: function (fn) {',
    '    if (fn === "account_snapshot_meta") return Promise.resolve({ data: { total: 3, changed: 3, next_since: "2026-01-01T00:00:00Z" }, error: null });',
    '    if (fn === "account_snapshot") return Promise.resolve({ data: [',
    '      { asset_id:"a1", serial_raw:"H-1", serial_key:"H1", kind:"fall_protection", is_deleted:false, updated_at:"2026-01-01T00:00:00Z" },',
    '      { asset_id:"a2", serial_raw:"H-2", serial_key:"H2", kind:"fall_protection", is_deleted:false, updated_at:"2026-01-01T00:00:01Z" },',
    '      { asset_id:"a3", serial_raw:"L-1", serial_key:"L1", kind:"ladder",          is_deleted:false, updated_at:"2026-01-01T00:00:02Z" }',
    '    ], error: null });',
    '    return Promise.resolve({ data: null, error: null });',
    '  },',
    '}; } };',
  ].join('\n');
}

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const b = await chromium.launch();

async function open({ configured = true, session = true, synced = false } = {}) {
  CONFIGURED = configured;
  // A fresh context per case, with the route registered on the CONTEXT: a
  // page-level route can be bypassed when a reload serves the script from the
  // browser cache, which silently let the real library load instead.
  const ctx = await b.newContext();
  await ctx.route(/supabase-js@2/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: stubScript(session) }));
  await ctx.route(/zxing-browser/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: 'window.ZXingBrowser={};' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => {
    // A deliberate 404 for config.json is the unconfigured case, not an error.
    if (m.type() === 'error' && !(configured === false && /404/.test(m.text()))) {
      errs.push('console: ' + m.text());
    }
  });
  await p.goto(BASE + '/index.html');
  if (synced) {
    await p.waitForTimeout(400);
    await p.evaluate(() => LiaSync.pullCatalog({}));
    await p.reload();
  }
  await p.waitForTimeout(800);
  return { p, errs, ctx };
}

const active = p => p.evaluate(() =>
  [...document.querySelectorAll('.screen')].filter(e => e.classList.contains('active')).map(e => e.id)[0]);

// A build with no config behaves exactly as it did before sync existed.
let { p, errs, ctx } = await open({ configured: false });
ok('an unconfigured build goes straight to jobs', await active(p), 'screen-jobs');
ok('and raises no errors', errs, []);
await p.close(); await ctx.close();

// ── Signing in is offered, not required ─────────────────────────────────────
// A tech who only wants to log on this phone and hand over a CSV is using the
// app as intended. The sign-in screen is offered once, and must not become a
// wall in front of an app that works perfectly well without an account.
({ p, errs, ctx } = await open({ configured: true, session: false }));
ok('a configured build with no session offers sign-in', await active(p), 'screen-auth');
ok('and offers working locally instead, as an equal choice',
   await p.$eval('#btn-work-offline', e => e.textContent.trim()), 'Start without an account');
ok('which says what it costs and what it does not',
   await p.$eval('#screen-auth', e => /share them as a CSV/.test(e.textContent) &&
                                      /sign in later from Settings/i.test(e.textContent)), true);

await p.click('#btn-work-offline');
await p.waitForTimeout(300);
ok('choosing that opens the app', await active(p), 'screen-jobs');

// The offer is remembered: being asked every morning after saying no once is
// how a tech learns to ignore the screen.
await p.reload();
await p.waitForTimeout(800);
ok('and is not asked again on the next start', await active(p), 'screen-jobs');

// But it must stay reachable, or local-only is a one-way door.
await p.evaluate(() => { if (typeof openSettings === 'function') openSettings(); });
await p.waitForTimeout(300);
ok('Settings offers a way back to signing in',
   await p.$eval('#signin-actions', e => e.style.display !== 'none'), true);
ok('and says what signing in would do',
   await p.$eval('#signin-pending', e => /Upload your work|would upload/.test(e.textContent)), true);
ok('no errors along the way', errs, []);
await p.close(); await ctx.close();

({ p, errs, ctx } = await open({ configured: true, session: true, synced: false }));
ok('a signed-in device with no catalogue must sync first', await active(p), 'screen-sync');
// The gate is the point: opening a job with no catalogue means typing all day.
await p.evaluate(() => { const j = Object.values(loadJobs())[0]; openJob(j.id); });
await p.waitForTimeout(400);
ok('and a job cannot be started until it has', await active(p), 'screen-sync');
ok('skipping is offered, but as a choice',
   await p.$eval('#btn-sync-later', e => e.textContent.trim()), 'Skip for now');

await p.click('#btn-sync-start');
await p.waitForTimeout(1400);
ok('after syncing the app opens on jobs', await active(p), 'screen-jobs');
ok('and the catalogue is on the device', await p.evaluate(() => LiaCache.status().then(s => s.count)), 3);
ok('freshness is shown to the tech',
   await p.$eval('#sync-status', e => /synced today/.test(e.textContent)), true);
await p.evaluate(() => { const j = Object.values(loadJobs())[0]; openJob(j.id); });
await p.waitForTimeout(400);
ok('and a job now opens', await active(p), 'screen-detail');
ok('no page errors through the whole flow', errs, []);
await p.close(); await ctx.close();

({ p, errs, ctx } = await open({ configured: true, session: true, synced: true }));
ok('a synced device opens straight on jobs next launch', await active(p), 'screen-jobs');
await p.close(); await ctx.close();

// ── Opening a job shows the work, not a keyboard ────────────────────────────
// Focusing the serial field on open raised the keyboard, which squeezed the
// ladder list off the screen — so the first thing a tech saw was a form
// covering the work he came to look at.
({ p, errs, ctx } = await open({ configured: false }));
await p.evaluate(() => {
  const all = loadJobs();
  const id = Object.keys(all)[0];
  openJob(id);
});
await p.waitForTimeout(500);
ok('opening a job does not put the cursor in the serial field',
   await p.evaluate(() => document.activeElement?.id || 'none'), 'none');
ok('and the Done button is hidden until something is focused',
   await p.$eval('#btn-entry-done', e => e.style.display), 'none');

await p.click('#fi-serial'); await p.waitForTimeout(200);
ok('tapping the field focuses it',
   await p.evaluate(() => document.activeElement?.id), 'fi-serial');
ok('and Done appears, so the keyboard can be put away',
   await p.$eval('#btn-entry-done', e => e.style.display !== 'none'), true);

await p.click('#btn-entry-done'); await p.waitForTimeout(200);
ok('pressing it releases the field',
   await p.evaluate(() => document.activeElement?.id || 'none'), 'none');
ok('no errors', errs, []);
await p.close(); await ctx.close();

await b.close();
server.close();
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
process.exit(fails ? 1 : 0);

