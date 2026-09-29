// Upload queue. The rule under test is that capture never depends on
// connectivity: records are queued locally, drained in order, never dropped on
// failure, and never sent twice. Run with `npm run test:field`.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'sync.js'), 'utf8');

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.route('**/*', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
await p.route('**/config.json', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ supabase: { url: 'https://x.supabase.co', anonKey: 'k' } }) }));
await p.goto('https://lia.test/');
await p.addScriptTag({ content: src });

const out = await p.evaluate(async () => {
  const log = [];
  let fails = 0;
  const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
    log.push((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

  // A stub standing in for Supabase, with a switchable failure mode.
  const sent = [];
  let mode = 'ok';
  window.supabase = { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: mode === 'noauth' ? null : { user: { id: 'u1' } } } }),
      signInWithPassword: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }),
      signOut: async () => ({}),
    },
    rpc: async (fn, args) => {
      if (mode === 'fail') return { data: null, error: { message: 'network down' } };
      sent.push({ fn, serial: args.p && args.p.serial_num });
      return { data: 'id-' + sent.length, error: null };
    },
  })};
  window.LiaCache = { clear: async () => { window.__cacheCleared = true; } };

  ok('configured when config.json has supabase', await LiaSync.isConfigured(), true);

  // Capture works with no connection at all.
  localStorage.removeItem('lia-upload-queue');
  LiaSync.enqueue({ clientId:'a', kind:'fall_protection', payload:{ serial_num:'H-1' } });
  LiaSync.enqueue({ clientId:'b', kind:'fall_protection', payload:{ serial_num:'H-2' } });
  LiaSync.enqueue({ clientId:'c', kind:'ladder',          payload:{ serial_num:'L-1' } });
  ok('captures queue locally', LiaSync.queueLength(), 3);

  // Nothing goes through while signed out — and nothing is lost either.
  mode = 'noauth';
  let r = await LiaSync.drain({});
  ok('signed out, nothing is sent', r.sent, 0);
  ok('and nothing is dropped', LiaSync.queueLength(), 3);
  ok('with a reason the tech can act on', /Sign in/.test(r.error || ''), true);

  // A failing connection must not lose records.
  mode = 'fail';
  r = await LiaSync.drain({});
  ok('a failed upload sends nothing', r.sent, 0);
  ok('and keeps every record', LiaSync.queueLength(), 3);
  ok('the failure is reported', /network down/.test(r.error || ''), true);
  ok('and the attempt is counted', LiaSync._readQueue()[0].attempts, 1);

  // Back online.
  mode = 'ok';
  r = await LiaSync.drain({});
  ok('everything uploads once a connection returns', r.sent, 3);
  ok('the queue empties', LiaSync.queueLength(), 0);
  ok('in the order they were captured', sent.map(s => s.serial), ['H-1','H-2','L-1']);
  ok('each routed to the right RPC',
     sent.map(s => s.fn), ['record_fp_inspection','record_fp_inspection','record_inspection']);

  // A second drain must not re-send.
  const before = sent.length;
  await LiaSync.drain({});
  ok('a drained queue does not re-send', sent.length, before);

  // Order is preserved across a partial failure: stop, do not skip.
  localStorage.removeItem('lia-upload-queue');
  LiaSync.enqueue({ clientId:'x', kind:'fall_protection', payload:{ serial_num:'H-9' } });
  LiaSync.enqueue({ clientId:'y', kind:'fall_protection', payload:{ serial_num:'H-10' } });
  mode = 'fail';
  await LiaSync.drain({});
  mode = 'ok';
  const mark = sent.length;
  await LiaSync.drain({});
  ok('a stalled queue resumes in order', sent.slice(mark).map(s => s.serial), ['H-9','H-10']);

  // What the tech is shown.
  localStorage.removeItem('lia-upload-queue');
  LiaSync.enqueue({ clientId:'z', kind:'fall_protection', payload:{ serial_num:'H-11' } });
  mode = 'fail'; await LiaSync.drain({}); await LiaSync.drain({}); await LiaSync.drain({});
  const sum = LiaSync.pendingSummary();
  ok('a stuck record is counted', sum.total, 1);
  ok('and flagged as not going through', sum.failing, 1);

  // Signing out must not leave one company's catalogue on the phone.
  await LiaSync.signOut();
  ok('signing out clears the catalogue', window.__cacheCleared, true);

  return { log, fails };
});
out.log.forEach(l => console.log(l));
console.log('\npage errors:', errs.length ? errs : 'none');
console.log(out.fails ? `RESULT: ${out.fails} failure(s)` : `RESULT: ${out.log.length} assertions passed`);
await b.close();
process.exit(out.fails || errs.length ? 1 : 0);
