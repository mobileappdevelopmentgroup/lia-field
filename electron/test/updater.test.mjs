// Automatic updates (electron/updater.cjs), driven with a fake electron-updater
// and fake timers. Pure Node: `node electron/test/updater.test.mjs`.
//
// What matters: a packaged app checks on its own and keeps checking; nothing
// it does can throw into Lia; a downloaded update is offered, never forced;
// and Restart is refused while an import is running.
import { createRequire } from 'module';
import { EventEmitter } from 'events';
const require = createRequire(import.meta.url);
const { createUpdater, FIRST_CHECK_MS, EVERY_MS } = require('../updater.cjs');

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

function rig({ packaged = true, checkFails = null } = {}) {
  const au = new EventEmitter();
  au.checks = 0; au.installs = [];
  au.checkForUpdates = async () => { au.checks++; if (checkFails) throw new Error(checkFails); return null; };
  au.quitAndInstall = (...a) => { au.installs.push(a); };
  const timers = { later: [], every: [],
    setTimeout(fn, ms) { this.later.push([fn, ms]); }, setInterval(fn, ms) { this.every.push([fn, ms]); return 1; },
    clearInterval() { this.every = []; } };
  const sent = [], logs = [];
  let busy = false;
  const u = createUpdater({
    autoUpdater: au, timers,
    app: { isPackaged: packaged, getVersion: () => '1.15.11' },
    isBusy: () => busy, send: (ch, v) => sent.push([ch, v]), log: m => logs.push(m),
  });
  return { u, au, timers, sent, logs, setBusy: b => { busy = b; } };
}
const settle = () => new Promise(r => setTimeout(r, 0));

// ── A dev run never updates ─────────────────────────────────────────────────
{
  const r = rig({ packaged: false });
  ok('a dev run does not start', [r.u.start(), r.timers.later.length, r.u.status().enabled], [false, 0, false]);
}

// ── A packaged app checks soon after launch, then every few hours ──────────
const r = rig();
ok('a packaged app starts', r.u.start(), true);
ok('downloads by itself and installs on quit, never a pre-release or a downgrade',
   [r.au.autoDownload, r.au.autoInstallOnAppQuit, r.au.allowPrerelease, r.au.allowDowngrade], [true, true, false, false]);
ok('first check shortly after launch, then every four hours',
   [r.timers.later.map(x => x[1]), r.timers.every.map(x => x[1])], [[FIRST_CHECK_MS], [EVERY_MS]]);
ok('starting twice does not double the checks', [r.u.start(), r.timers.every.length], [false, 1]);
r.timers.later[0][0](); await settle();
r.timers.every[0][0](); await settle();
ok('each timer checks', r.au.checks, 2);

// ── An update arrives ───────────────────────────────────────────────────────
r.au.emit('update-available', { version: '1.15.12' });
ok('while it downloads, status says which', r.u.status().available, '1.15.12');
ok('nothing to install yet', r.u.install(), { ok: false, error: 'No update is ready yet.' });
r.au.emit('update-downloaded', { version: '1.15.12' });
ok('the screen is told it is ready', r.sent.filter(s => s[0] === 'update:ready'), [['update:ready', { version: '1.15.12' }]]);
ok('nothing installs by itself while Lia is open', r.au.installs, []);
r.timers.every[0][0](); await settle();
ok('once one is waiting, it stops checking', r.au.checks, 2);

r.setBusy(true);
ok('Restart is refused during an import', [r.u.install().ok, r.au.installs.length], [false, 0]);
r.setBusy(false);
ok('and works after it', [r.u.install(), r.au.installs], [{ ok: true }, [[false, true]]]);

// ── Failures stay inside ────────────────────────────────────────────────────
{
  const f = rig({ checkFails: 'getaddrinfo ENOTFOUND github.com' });
  f.u.start();
  let threw = false;
  try { await f.u.check(); f.au.emit('error', new Error('sha512 checksum mismatch')); } catch { threw = true; }
  ok('an offline check and a bad download throw nothing', threw, false);
  ok('they are noted for the log', [f.u.status().lastError, f.logs.length >= 2], ['sha512 checksum mismatch', true]);
  ok('and the next check still runs', (await f.u.check(), f.au.checks), 2);

  const g = rig();
  g.u.start();
  g.au.emit('update-downloaded', { version: '9.9.9' });
  g.au.quitAndInstall = () => { throw new Error('read-only volume'); };
  ok('a restart that fails says so instead of throwing',
     g.u.install(), { ok: false, error: 'Could not restart to update: read-only volume' });

  const h = createUpdater({ autoUpdater: null, app: { isPackaged: true, getVersion: () => 'x' },
                            isBusy: () => false, send() {}, log() {}, timers: r.timers });
  ok('a broken updater module does not start, and does not throw', h.start(), false);
}

console.log(fails ? `\n${fails} FAILED` : '\nAll updater assertions passed.');
process.exit(fails ? 1 : 0);
