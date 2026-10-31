// A missing work order must never stop a ladder, and must be said ON SCREEN.
//
// Reported 2026-10-22, every phone at once: "I go to add a ladder, the keyboard
// pops up, and the ladder doesn't add." Signed in, a ladder with no work order
// was refused, and the message went into the top bar's ten-pixel save status,
// which could not shrink: at phone width it pushed the job name and the work
// order box off the right edge. The cursor went into a box nobody could see,
// the keyboard came up, and nothing said why.
//
// Since 1.15.5 the ladder is taken and a red line asks for the number until it
// is typed — a missing work order nags, it does not stop a crew.
//
// upload.test.mjs checked the message's TEXT, which was there all along. This
// checks what a tech can actually see: geometry against the viewport, at the
// widths real phones have.
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

// Signed in, with one catalogue row so a job will open (boot.test.mjs covers
// that gate).
const STUB = `
window.supabase = { createClient: function () { return {
  auth: {
    getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'u1' } } } }); },
    signInWithPassword: function () { return Promise.resolve({ data: {}, error: null }); },
    signOut: function () { return Promise.resolve({}); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  },
  rpc: function (fn) {
    if (fn === 'account_snapshot_meta') return Promise.resolve({ data: { total: 1, changed: 1, next_since: '2026-01-01T00:00:00Z' }, error: null });
    if (fn === 'account_snapshot') return Promise.resolve({ data: window.__snapDone ? [] : (window.__snapDone = true, [
      { asset_id: 'a1', serial_raw: 'L-1', serial_key: 'L1', kind: 'ladder', is_deleted: false, updated_at: '2026-01-01T00:00:00Z' }
    ]), error: null });
    return Promise.resolve({ data: null, error: null });
  },
}; } };`;

const b = await chromium.launch();

// A job with no work order, open on the entry screen, signed in.
async function openUnnumberedJob(width) {
  const ctx = await b.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
  await ctx.route(/supabase-js@2/, r => r.fulfill({ status: 200, contentType: 'text/javascript',
    headers: { 'cache-control': 'no-store' }, body: STUB }));
  await ctx.route(/zxing-browser/, r => r.fulfill({ status: 200, contentType: 'text/javascript',
    headers: { 'cache-control': 'no-store' }, body: 'window.ZXingBrowser={};' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(600);
  await p.evaluate(() => LiaSync.pullCatalog({}));
  await p.reload();
  await p.waitForTimeout(700);
  await p.evaluate(() => { LiaSyncState.forgetSyncing(); return LiaSyncState.syncing(); });
  await p.evaluate(() => {
    const all = loadJobs();
    const id = Object.keys(all)[0];
    all[id].workOrderNum = ''; delete all[id].assignedId;
    saveJobs(all);
    openJob(id);
  });
  await p.waitForTimeout(300);
  return { p, ctx, errs };
}

// Fully inside the viewport, and wide enough to read or tap.
const onScreen = (p, sel, minW) => p.evaluate(([sel, minW]) => {
  const e = document.querySelector(sel);
  if (!e) return false;
  const r = e.getBoundingClientRect();
  const shown = getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  return shown && r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 &&
         r.bottom <= innerHeight && r.width >= minW && r.height > 0;
}, [sel, minW]);

const ladders = (p) => p.evaluate(() => (_job.ladders || []).length);

// Narrowest Android through the largest iPhone.
for (const width of [320, 360, 375, 390, 412, 430]) {
  console.log(`-- ${width}px`);
  const { p, ctx, errs } = await openUnnumberedJob(width);

  ok('the work order box is on screen before anything is tapped', await onScreen(p, '#job-wo', 60), true);

  const before = await ladders(p);
  await p.fill('#fi-serial', 'VIS-1');
  await p.click('#btn-add-ladder');
  await p.waitForTimeout(150);

  ok('with no work order the ladder is still taken', (await ladders(p)) - before, 1);
  ok('the missing work order is said on screen, whole', await onScreen(p, '#entry-notice', width - 1), true);
  ok('and named', await p.evaluate(() => /work order/i.test(document.getElementById('entry-notice')?.textContent || '')), true);
  ok('the work order box is on screen', await onScreen(p, '#job-wo', 60), true);
  ok('and marked', await p.$eval('#job-wo', e => e.classList.contains('missing')), true);
  ok('so is the job name', await onScreen(p, '#job-name', 60), true);
  ok('the top bar does not overflow',
     await p.$eval('#detail-topbar', e => e.scrollWidth <= e.clientWidth + 1), true);
  ok('the cursor is back at a serial field on screen, ready for the next',
     [await p.evaluate(() => document.activeElement.id), await onScreen(p, '#fi-serial', 60)], ['fi-serial', true]);

  await p.fill('#fi-serial', 'VIS-2');
  await p.click('#btn-add-ladder');
  await p.waitForTimeout(150);
  ok('the next is taken too', (await ladders(p)) - before, 2);
  ok('and the line stays until a number is typed', await onScreen(p, '#entry-notice', width - 1), true);

  // Reopened later, still with no number, it says so before anything is tapped.
  await p.evaluate(() => { saveNow(); openJob(_job.id); });
  await p.waitForTimeout(100);
  ok('a job reopened with ladders and no number says so', await onScreen(p, '#entry-notice', width - 1), true);

  // Typed and tapped at once — no waiting out the 800ms autosave.
  await p.fill('#fi-serial', 'VIS-3');
  await p.type('#job-wo', 'WO-77');
  await p.click('#btn-add-ladder');
  await p.waitForTimeout(150);
  ok('a number typed and Add tapped at once is taken', (await ladders(p)) - before, 3);
  ok('and carries that number up',
     await p.evaluate(() => LiaSync._readQueue().filter(e => e.kind === 'ladder' && e.payload.serial_num === 'VIS-3').pop().payload.work_order_id), 'WO-77');
  ok('the earlier ones go again with it',
     await p.evaluate(() => LiaSync._readQueue().filter(e => e.kind === 'ladder' && e.payload.serial_num === 'VIS-1').pop().payload.work_order_id), 'WO-77');
  ok('the line is gone', await p.evaluate(() => { const e = document.getElementById('entry-notice'); return e ? getComputedStyle(e).display : 'none'; }), 'none');
  ok('and so is the mark', await p.$eval('#job-wo', e => e.classList.contains('missing')), false);

  // Whatever lands in the status slot later, it cannot push the job off screen.
  await p.evaluate(() => setSaveStatus('x'.repeat(400)));
  ok('a long status cannot push the work order box off screen', await onScreen(p, '#job-wo', 60), true);
  ok('or the job name', await onScreen(p, '#job-name', 60), true);
  ok('or overflow the top bar', await p.$eval('#detail-topbar', e => e.scrollWidth <= e.clientWidth + 1), true);

  // No serial: the cursor goes to the serial field, which must be visible too.
  await p.evaluate(() => setSaveStatus(''));
  await p.fill('#fi-serial', '');
  await p.click('#btn-add-ladder');
  await p.waitForTimeout(150);
  ok('with no serial the cursor goes to a serial field on screen',
     [await p.evaluate(() => document.activeElement.id), await onScreen(p, '#fi-serial', 60)], ['fi-serial', true]);

  ok('no page errors', errs, []);
  await ctx.close();
}

// ── The status slot is for "Saving…" and "Saved" only ───────────────────────
// It is ten pixels and capped at a quarter of the bar; a sentence there is
// cut off. Sentences go through showEntryNotice. Checked in the source so the
// next message somebody adds goes to the right place.
{
  const dir = path.join(ROOT, 'field-app', 'js');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/setSaveStatus\(([^)]*)\)/);
      if (!m || /^\s*function\s/.test(line)) return;
      if (!/^\s*(''|'saved'|'saving…'|text)\s*$/.test(m[1])) bad.push(`${f}:${i + 1} ${line.trim()}`);
    });
  }
  ok('setSaveStatus is only given "", "saved" or "saving…"', bad, []);
}

await b.close();
server.close();
console.log(fails ? `\nRESULT: ${fails} failed` : '\nRESULT: all passed');
process.exit(fails ? 1 : 0);
