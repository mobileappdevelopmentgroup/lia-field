// Lia Field — backup.js
//
// A copy of the tech's work kept OUTSIDE the web view, so an app update cannot
// take it.
//
// Everything a tech captures — jobs, the ladders on them, the upload queue —
// lives in localStorage, and on a phone that is the web view's own store
// (Library/WebKit on iOS). Testers reported jobs gone after a TestFlight
// update. The app has never cleared them on a version change, so the store was
// wiped underneath it; iOS also evicts web view storage when the phone runs
// short of space. A file the app writes itself, in Library, is part of the
// app's own container and survives both.
//
// So every change to the keys below is mirrored, a second or so later, into a
// file through Capacitor's Filesystem plugin. At start-up, any key that is
// missing from localStorage but present in the file is put back, and the page
// reloads once so every module reads the restored state.
//
// Only what a tech made and cannot get back from the server is kept. Not the
// sign-in session (a refresh token has no business in a plain file, or in the
// phone's iCloud backup — signing in again is the cost), and not the caches
// sync pulls down again: the assigned-job list and blank tag stock are cleared
// on sign-out on purpose, and a backup must not resurrect them for whoever
// signs in next.
//
// Loaded FIRST, before any other script: it has to see which keys were missing
// before another module writes a default into one (a first run seeds a demo
// job, and that would hide the jobs that were lost).
//
// Does nothing in a browser. Pages and the PWA have no Filesystem plugin, and
// their storage is not touched by an app update.

(function (root) {
  'use strict';

  var KEYS = [
    'lia-field-jobs',        // jobs, ladders and items — the CSVs
    'lia-upload-queue',      // records not yet on the server
    'lia-sent-records',      // which of those the server already has
    'lia-support-tickets',
    'lia-parts-library',
    'lia-part-sets',
    'lia-quick-parts',
    'lia-custom-fields',
    'lia-cert-base-url',
    'lia-theme',
    'lia-sounds',
  ];
  var TRACKED = {};
  KEYS.forEach(function (k) { TRACKED[k] = true; });

  // Two files, written alternately. A write cut short by the phone killing the
  // app leaves the other one whole; restore takes the newest that parses.
  var SLOTS = ['lia-backup-a.json', 'lia-backup-b.json'];
  var DIR = 'LIBRARY';
  var DELAY_MS = 1000;

  function fs() {
    var cap = root.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
    var F = cap.Plugins && cap.Plugins.Filesystem;
    return F && typeof F.readFile === 'function' && typeof F.writeFile === 'function' ? F : null;
  }

  function get(k) { try { return root.localStorage.getItem(k); } catch (_) { return null; } }

  // Decided synchronously, before any other script has run.
  var missingAtStart = KEYS.filter(function (k) { return get(k) === null; });

  var _ready = false;      // nothing is written until the restore check is done
  var _timer = null;
  var _slot = 0;
  var _seq = 0;

  function snapshot() {
    var keys = {};
    KEYS.forEach(function (k) { var v = get(k); if (v !== null) keys[k] = v; });
    return {
      v: 1,
      seq: ++_seq,
      savedAt: new Date().toISOString(),
      appVersion: typeof LIA_APP_VERSION === 'string' ? LIA_APP_VERSION : '',
      keys: keys,
    };
  }

  function write() {
    _timer = null;
    var F = fs();
    if (!F || !_ready) return Promise.resolve(false);
    var body = JSON.stringify(snapshot());
    var path = SLOTS[_slot];
    _slot = 1 - _slot;
    return Promise.resolve()
      .then(function () { return F.writeFile({ path: path, directory: DIR, data: body, encoding: 'utf8', recursive: true }); })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function schedule() {
    if (!_ready || !fs()) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(write, DELAY_MS);
  }

  function flush() {
    if (_timer) { clearTimeout(_timer); return write(); }
    return Promise.resolve(false);
  }

  function readSlot(F, path) {
    return Promise.resolve()
      .then(function () { return F.readFile({ path: path, directory: DIR, encoding: 'utf8' }); })
      .then(function (r) {
        var b = JSON.parse(r && r.data);
        return b && b.v === 1 && b.keys && typeof b.keys === 'object' ? b : null;
      })
      .catch(function () { return null; });
  }

  // Newest whole backup, or null.
  function newest(F) {
    return Promise.all(SLOTS.map(function (p) { return readSlot(F, p); })).then(function (bs) {
      var best = null, bestSlot = 0;
      bs.forEach(function (b, i) {
        // By sequence, not clock: a phone's clock can be wrong or moved.
        if (b && (!best || (Number(b.seq) || 0) > (Number(best.seq) || 0))) { best = b; bestSlot = i; }
      });
      // Write the next save into the OTHER slot, so the good one is kept until
      // a newer one is whole.
      _slot = best ? 1 - bestSlot : 0;
      if (best) _seq = Number(best.seq) || 0;
      return best;
    });
  }

  // Puts back every key that was missing when the app started. Resolves to
  // the keys restored.
  function restore() {
    var F = fs();
    if (!F) { _ready = true; return Promise.resolve([]); }
    return newest(F).then(function (b) {
      var put = [];
      if (b) {
        missingAtStart.forEach(function (k) {
          if (typeof b.keys[k] !== 'string') return;
          try { root.localStorage.setItem(k, b.keys[k]); put.push(k); } catch (_) {}
        });
      }
      _ready = true;
      if (put.length) {
        try { root.sessionStorage.setItem('lia-restored', JSON.stringify(put)); } catch (_) {}
      }
      return put;
    }).catch(function () { _ready = true; return []; });
  }

  // Every write to a tracked key schedules a backup — wherever in the app it
  // comes from. Patching Storage once is what keeps a new key from silently
  // going unbacked-up because somebody forgot to call this from a new module.
  if (fs()) {
    try {
      var S = root.Storage && root.Storage.prototype;
      if (S) {
        var set = S.setItem, rem = S.removeItem, clr = S.clear;
        S.setItem = function (k, v) { set.call(this, k, v); if (this === root.localStorage && TRACKED[k]) schedule(); };
        S.removeItem = function (k) { rem.call(this, k); if (this === root.localStorage && TRACKED[k]) schedule(); };
        S.clear = function () { clr.call(this); if (this === root.localStorage) schedule(); };
      }
    } catch (_) {}

    // The phone may kill a backgrounded app without warning; write now.
    root.document.addEventListener('visibilitychange', function () {
      if (root.document.visibilityState === 'hidden') flush();
    });

    // Restore before the app is used. Anything restored means the page started
    // without it, so reload once and let every module read it afresh.
    restore().then(function (put) {
      if (put.length) { root.location.reload(); return; }
      schedule();   // first run on a build with backups: take one now
    });
  } else {
    _ready = true;
  }

  // How many jobs came back, for the notice boot.js shows. Read once.
  function takeRestoredNotice() {
    try {
      var put = JSON.parse(root.sessionStorage.getItem('lia-restored') || 'null');
      root.sessionStorage.removeItem('lia-restored');
      return put;
    } catch (_) { return null; }
  }

  root.LiaBackup = {
    KEYS: KEYS,
    flush: flush,
    restore: restore,
    takeRestoredNotice: takeRestoredNotice,
  };
})(window);
