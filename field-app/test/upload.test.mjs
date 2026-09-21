// Getting a day's work to the server.
//
// Reported from a real phone: "it uploads one at a time and the last record it
// refuses to upload", with ticks on everything else. The queue stopped at the
// first record the server would not take and waited on it forever, so one bad
// record meant nothing uploaded — while the app called it "waiting".
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

// A stub that records every call and can be told to refuse one serial.
function stubScript(badSerial) {
  return `
window.__calls = [];
window.supabase = { createClient: function () { return {
  auth: {
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1' } } } }); },
    signInWithPassword: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function (fn, args) {
    window.__calls.push({ fn: fn, p: args && args.p });
    if (fn === 'account_snapshot_meta') return Promise.resolve({ data: { total: 0, changed: 0, next_since: null }, error: null });
    if (fn === 'account_snapshot') return Promise.resolve({ data: [], error: null });
    var bad = ${JSON.stringify(badSerial)};
    if (fn === 'record_inspections') {
      var rows = args.p || [];
      if (bad && rows.some(function (r) { return r.serial_num === bad; })) {
        return Promise.resolve({ data: null, error: { message: 'A serial number is required' } });
      }
      return Promise.resolve({ data: rows.length, error: null });
    }
    if (fn === 'record_inspection') {
      if (bad && args.p && args.p.serial_num === bad) {
        return Promise.resolve({ data: null, error: { message: 'A serial number is required' } });
      }
      return Promise.resolve({ data: 'id', error: null });
    }
    return Promise.resolve({ data: null, error: null });
  },
}; } };`;
}

const b = await chromium.launch();

async function open(badSerial) {
  const ctx = await b.newContext();
  await ctx.route(/supabase-js@2/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: stubScript(badSerial) }));
  await ctx.route(/zxing-browser/, r =>
    r.fulfill({ status: 200, contentType: 'text/javascript',
                headers: { 'cache-control': 'no-store' }, body: 'window.ZXingBrowser={};' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(600);
  return { p, ctx, errs };
}

const queueLadders = (serials) => `
  ${JSON.stringify(serials)}.forEach(function (sn) {
    LiaSync.enqueue({ clientId: 'c-' + sn, kind: 'ladder',
                      payload: { serial_num: sn, work_order_id: 'WO-1' } });
  });`;

// ── A whole job goes up in one call ─────────────────────────────────────────
// Forty ladders was forty round trips, each waiting on the last.
let { p, ctx, errs } = await open(null);
await p.evaluate(queueLadders(['A1','A2','A3','A4','A5']));
let res = await p.evaluate(() => LiaSync.drain({}));
ok('all five are sent', res.sent, 5);
ok('and nothing is left waiting', res.remaining, 0);
ok('in ONE call, not five',
   await p.evaluate(() => window.__calls.filter(c => c.fn === 'record_inspections').length), 1);
ok('and it carried every record',
   await p.evaluate(() => window.__calls.find(c => c.fn === 'record_inspections').p.length), 5);
ok('each one is marked as on the server',
   await p.evaluate(() => ['A1','A3','A5'].map(s => LiaSyncState.stateOf('c-' + s))),
   ['uploaded','uploaded','uploaded']);
await p.close(); await ctx.close();

// ── One bad record must not hold up the rest ────────────────────────────────
({ p, ctx, errs } = await open('A3'));
await p.evaluate(queueLadders(['A1','A2','A3','A4','A5']));

// Three passes: the batch fails, the singles isolate the bad one, and after
// three refusals it steps aside so the rest of the day can go up.
for (let i = 0; i < 3; i++) await p.evaluate(() => LiaSync.drain({}));

ok('the four good records are on the server',
   await p.evaluate(() => ['A1','A2','A4','A5'].map(s => LiaSyncState.stateOf('c-' + s))),
   ['uploaded','uploaded','uploaded','uploaded']);
ok('the bad one is still held, never dropped',
   await p.evaluate(() => LiaSync.queueLength()), 1);
ok('and it is marked as refused rather than merely waiting',
   await p.evaluate(() => LiaSyncState.stateOf('c-A3')), 'failing');
ok('with the server\'s own words kept for the tech',
   await p.evaluate(() => LiaSyncState.waiting()[0].lastError), 'A serial number is required');
ok('the batch was tried first, then singles',
   await p.evaluate(() => window.__calls.filter(c => c.fn === 'record_inspections').length > 0 &&
                          window.__calls.filter(c => c.fn === 'record_inspection').length > 0), true);
ok('no page errors', errs, []);
await p.close(); await ctx.close();

// ── A record queued while offline waits, and goes up later ──────────────────
({ p, ctx, errs } = await open(null));
await p.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); });
await p.evaluate(queueLadders(['B1']));
await p.waitForTimeout(300);
ok('nothing is sent while the phone is offline',
   await p.evaluate(() => window.__calls.filter(c => /record_inspection/.test(c.fn)).length), 0);
ok('and the record is kept', await p.evaluate(() => LiaSync.queueLength()), 1);

await p.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); });
res = await p.evaluate(() => LiaSync.drain({}));
ok('it goes up once there is signal again', res.sent, 1);
await p.close(); await ctx.close();

// ── A work order is not required to upload ─────────────────────────────────
// Holding a record until somebody types one meant a tech who filled it in at
// the end of the job uploaded nothing all morning, and could not tell why.
({ p, ctx, errs } = await open(null));
await p.evaluate(() => {
  LiaSync.enqueue({ clientId: 'c-NOWO', kind: 'ladder', payload: { serial_num: 'NOWO-1' } });
});
res = await p.evaluate(() => LiaSync.drain({}));
ok('a ladder with no work order still uploads', res.sent, 1);
ok('and is marked as on the server',
   await p.evaluate(() => LiaSyncState.stateOf('c-NOWO')), 'uploaded');

// Adding one later has to reach the server, or the office can never match it.
await p.evaluate(() => {
  LiaSyncState.markUnsent('c-NOWO');
  LiaSync.enqueue({ clientId: 'c-NOWO', kind: 'ladder',
                    payload: { serial_num: 'NOWO-1', work_order_id: 'WO-LATE' } });
});
res = await p.evaluate(() => LiaSync.drain({}));
ok('and sending it again attaches the work order', res.sent, 1);
ok('which the server was told about',
   await p.evaluate(() => window.__calls.filter(c => /record_inspection/.test(c.fn)).pop().p.work_order_id
                       || window.__calls.filter(c => /record_inspection/.test(c.fn)).pop().p[0]?.work_order_id),
   'WO-LATE');
ok('no page errors', errs, []);
await p.close(); await ctx.close();

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll upload assertions passed.');
process.exit(fails ? 1 : 0);
