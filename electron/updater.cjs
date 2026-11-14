// Lia Office — updater.cjs
//
// Automatic updates (1.15.11+). Releases are published to GitHub Releases on
// mobileappdevelopmentgroup/lia-field (public repo, so no token ships in the
// app); electron-updater reads latest.yml / latest-mac.yml there, downloads
// in the background and checks the file's sha512 before using it. On a Mac
// the update must also be signed by the same Developer ID as the app that is
// running — Squirrel refuses anything else.
//
// Rules, all load-bearing:
//   * It never gets in the way. Every failure — offline, GitHub down, a bad
//     download — is logged and the app carries on as it is. Nothing here
//     throws into the caller.
//   * It never interrupts an import. The update is downloaded quietly and
//     installed when Lia is next quit, or when the office presses Restart —
//     which is refused while an import or a fall-protection push is running.
//   * Only a packaged app updates. A dev run never checks.
//   * A release is published as a DRAFT and is invisible to the updater until
//     it is published by hand (docs/RELEASE.md), so a build is checked before
//     every office gets it.
//
// Dependencies are passed in so electron/test/updater.test.mjs can drive it
// without Electron.

'use strict';

const FIRST_CHECK_MS = 15 * 1000;          // after the window is up
const EVERY_MS = 4 * 60 * 60 * 1000;      // offices leave Lia open for days

function createUpdater({ autoUpdater, app, isBusy, send, log, timers }) {
  const t = timers || { setTimeout, setInterval, clearInterval };
  const state = {
    current: safe(() => app.getVersion(), 'unknown'),
    checking: false,
    available: null,     // version being downloaded
    ready: null,         // version downloaded and waiting to install
    lastChecked: null,
    lastError: null,
  };
  let started = false, interval = null;

  function safe(fn, fallback) { try { return fn(); } catch (_) { return fallback; } }
  function tell(ch, v) { safe(() => send(ch, v)); }
  function note(err) {
    state.lastError = String(err && err.message || err).slice(0, 300);
    safe(() => log('[updater] ' + state.lastError));
  }

  async function check() {
    if (!started || state.checking || state.ready) return status();
    state.checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      note(err);
    } finally {
      state.checking = false;
      state.lastChecked = new Date().toISOString();
    }
    return status();
  }

  function start() {
    if (started) return false;
    if (!safe(() => app.isPackaged, false)) return false;
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.allowDowngrade = false;
      autoUpdater.logger = { info() {}, warn: m => safe(() => log('[updater] ' + m)), error: note, debug() {} };
      autoUpdater.on('error', note);
      autoUpdater.on('update-available', info => {
        state.available = info && info.version || null;
        tell('update:status', status());
      });
      autoUpdater.on('update-downloaded', info => {
        state.available = null;
        state.ready = info && info.version || 'new';
        tell('update:ready', { version: state.ready });
      });
    } catch (err) { note(err); return false; }
    started = true;
    t.setTimeout(() => { check(); }, FIRST_CHECK_MS);
    interval = t.setInterval(() => { check(); }, EVERY_MS);
    return true;
  }

  // The office pressed Restart. Refused mid-import: quitting would kill the
  // browser half-way down a work order.
  function install() {
    if (!state.ready) return { ok: false, error: 'No update is ready yet.' };
    if (safe(() => isBusy(), true)) return { ok: false, error: 'An import is running — Lia will update when it is finished and closed.' };
    try {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) { note(err); return { ok: false, error: 'Could not restart to update: ' + state.lastError }; }
  }

  function status() {
    return { current: state.current, checking: state.checking, available: state.available, ready: state.ready,
             lastChecked: state.lastChecked, lastError: state.lastError, enabled: started };
  }

  function stop() { if (interval) t.clearInterval(interval); interval = null; }

  return { start, check, install, status, stop };
}

module.exports = { createUpdater, FIRST_CHECK_MS, EVERY_MS };
