// Jobs survive the web view's storage being wiped under the app.
//
// Testers lost every job on an iOS update. backup.js mirrors the tech's work
// into a file through Capacitor's Filesystem plugin and puts it back when
// localStorage comes up empty. Here the plugin is a stub whose files live in
// the test process, so they outlast the page the way a file in the app's
// Library outlasts a wiped WebKit store.
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

// The "phone's" files: path → contents. Kept here, outside every page.
const files = new Map();
let writes = 0;
const newest = () => [...files.values()].map(s => JSON.parse(s)).sort((a, b) => b.seq - a.seq)[0];

const b = await chromium.launch();

async function phone({ native = true } = {}) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.exposeFunction('__fsWrite', (k, v) => { files.set(k, v); writes++; });
  await p.exposeFunction('__fsRead', (k) => files.has(k) ? files.get(k) : null);
  await p.addInitScript((native) => {
    if (!native) return;
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Filesystem: {
        writeFile: (o) => { if (o.directory !== 'LIBRARY') throw new Error('wrong directory');
          return window.__fsWrite(o.path, o.data).then(() => ({ uri: 'file:///' + o.path })); },
        readFile: (o) => window.__fsRead(o.path).then(d => { if (d === null) throw new Error('missing'); return { data: d }; }),
      } },
    };
  }, native);
  await p.goto(BASE + '/index.html');
  await p.waitForTimeout(600);
  return { ctx, p, errs };
}

// ── First launch on a build with backups ───────────────────────────────────
let { ctx, p, errs } = await phone();
await p.waitForTimeout(1300);
ok('a backup is taken on first launch', files.size, 1);
ok('and it is written into Library', [...files.keys()][0].startsWith('lia-backup-'), true);

await p.evaluate(() => {
  const all = loadJobs();
  all['j1'] = { id: 'j1', name: 'Ford plant', workOrderNum: 'WO-1', scope: 'ladder',
    ladders: [{ id: 'l1', serialNum: '100200', brand: 'LG', parts: [] }], items: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
  saveJobs(all);
  localStorage.setItem('lia-upload-queue', JSON.stringify([{ clientId: 'c1', kind: 'ladder' }]));
  localStorage.setItem('sb-x-auth-token', '{"refresh_token":"secret"}');
});
await p.waitForTimeout(1400);
const saved = newest();
ok('a change to the jobs reaches the backup', !!JSON.parse(saved.keys['lia-field-jobs']).j1, true);
ok('and so does the upload queue', JSON.parse(saved.keys['lia-upload-queue'])[0].clientId, 'c1');
ok('the sign-in session is never written to the file',
   Object.keys(saved.keys).some(k => k.startsWith('sb-')) || JSON.stringify(saved).includes('secret'), false);
ok('the two files are written alternately', files.size, 2);
ok('no page errors', errs, []);
await ctx.close();

// ── The update: web view storage gone, files still there ───────────────────
({ ctx, p, errs } = await phone());   // a new context is an empty localStorage
await p.waitForTimeout(1500);
ok('the job is back', await p.evaluate(() => loadJobs().j1 && loadJobs().j1.ladders[0].serialNum), '100200');
ok('and is on the list, not just in storage',
   await p.$$eval('.job-card', cs => cs.some(c => c.textContent.includes('Ford plant'))), true);
ok('the queue is back, so nothing waiting to upload was lost',
   await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue'))[0].clientId), 'c1');
ok('the tech is told why', await p.$eval('#jf-restored', e => /put back from its backup/.test(e.textContent)), true);
ok('the session is not restored — they sign in again',
   await p.evaluate(() => localStorage.getItem('sb-x-auth-token')), null);
ok('no page errors after restoring', errs, []);

// Restoring must not loop: the next launch has its storage and does nothing.
await p.reload(); await p.waitForTimeout(800);
ok('a launch with storage intact restores nothing and says nothing',
   await p.$('#jf-restored'), null);
ok('the job is still there', await p.evaluate(() => !!loadJobs().j1), true);

// A job deleted on purpose stays deleted: only MISSING keys are restored.
await p.evaluate(() => { const all = loadJobs(); delete all.j1; saveJobs(all); });
await p.waitForTimeout(1300);
await p.reload(); await p.waitForTimeout(800);
ok('a job the tech deleted does not come back', await p.evaluate(() => !!loadJobs().j1), false);
await ctx.close();

// ── A backup cut short ─────────────────────────────────────────────────────
// Add two jobs, each saved in turn into both slots, then tear the newest one.
({ ctx, p } = await phone());
await p.evaluate(() => { const all = loadJobs(); all.j2 = { id: 'j2', name: 'Torn', ladders: [], items: [] }; saveJobs(all); });
await p.waitForTimeout(1300);
await p.evaluate(() => { const all = loadJobs(); all.j3 = { id: 'j3', name: 'Later', ladders: [], items: [] }; saveJobs(all); });
await p.waitForTimeout(1300);
await ctx.close();
const order = [...files.entries()].sort((x, y) => JSON.parse(y[1]).seq - JSON.parse(x[1]).seq);
files.set(order[0][0], order[0][1].slice(0, 40));   // newest is half-written
({ ctx, p, errs } = await phone());
await p.waitForTimeout(1500);
ok('a half-written backup is passed over for the whole one before it',
   await p.evaluate(() => [!!loadJobs().j2, !!loadJobs().j3]), [true, false]);
ok('no page errors', errs, []);
await ctx.close();

// ── In a browser it does nothing ───────────────────────────────────────────
files.clear(); writes = 0;
({ ctx, p, errs } = await phone({ native: false }));
await p.evaluate(() => saveJobs({ x: { id: 'x', ladders: [], items: [] } }));
await p.waitForTimeout(1300);
ok('the PWA writes no files', writes, 0);
ok('and loads cleanly', errs, []);
await ctx.close();

await b.close();
server.close();
console.log(fails ? `\n${fails} failed` : '\nAll backup assertions passed.');
process.exit(fails ? 1 : 0);
