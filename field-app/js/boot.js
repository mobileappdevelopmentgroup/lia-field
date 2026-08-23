// Lia Field — boot.js
//
// Decides which screen the app opens on, and owns sign-in and the first sync.
//
// Three shapes the app can be in:
//   not configured  → straight to jobs, exactly as it always behaved
//   configured, no session → sign in
//   signed in, catalogue never pulled → first sync
//
// Loaded after every other module, so everything it calls already exists.

(function () {
  'use strict';

  function msg(id, text, isErr) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'auth-msg' + (isErr ? ' err' : '');
  }

  // A tech who installs in a dead zone and drives to a site would otherwise have
  // an empty catalogue — every item would look new and he would be typing all
  // day. So a job cannot be started until the catalogue has come down once.
  function guardJobStart(fn) {
    return function () {
      const sync = window.LiaSync;
      if (!sync) return fn.apply(this, arguments);
      const args = arguments, self = this;
      sync.isConfigured().then(function (configured) {
        if (!configured) return fn.apply(self, args);
        return window.LiaCache.requireFirstSync()
          .then(function () { fn.apply(self, args); })
          .catch(function () { goScreen('sync'); });
      });
    };
  }

  function startSync() {
    const btn = $('btn-sync-start');
    if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
    msg('sync-msg', '');
    const fill = $('sync-fill');

    window.LiaSync.pullCatalog({
      onProgress: function (done, total) {
        if (fill) fill.style.width = total ? Math.round((done / total) * 100) + '%' : '100%';
        const sub = $('sync-sub');
        if (sub && total) sub.textContent = `${done} of ${total} items…`;
      },
    }).then(function (r) {
      if (fill) fill.style.width = '100%';
      msg('sync-msg', `${r.total} items ready. This device now works with no signal.`);
      setTimeout(function () { goScreen('jobs'); renderJobList(); renderSyncStatus(); }, 700);
    }).catch(function (err) {
      msg('sync-msg', err.message || 'Could not download the equipment list.', true);
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    });
  }

  // Shows when the catalogue was last refreshed. A tech looking at a record that
  // is months stale should be able to see that, rather than trusting it blindly.
  function renderSyncStatus() {
    const el = $('sync-status');
    if (!el || !window.LiaCache) return;
    window.LiaCache.status().then(function (s) {
      if (!s.ready) { el.textContent = 'Not synced'; el.className = 'sync-status stale'; return; }
      const days = Math.floor((Date.now() - new Date(s.lastSyncAt)) / 86400000);
      el.textContent = days <= 0 ? `${s.count} items · synced today`
                     : `${s.count} items · synced ${days}d ago`;
      el.className = 'sync-status' + (days > 14 ? ' stale' : '');
    }).catch(function () {});
  }
  window.renderSyncStatus = renderSyncStatus;

  function signIn() {
    const email = ($('auth-email') || {}).value || '';
    const pass = ($('auth-pass') || {}).value || '';
    if (!email.trim() || !pass) { msg('auth-msg', 'Enter your email and password.', true); return; }
    msg('auth-msg', 'Signing in…');
    window.LiaSync.signIn(email.trim(), pass).then(function () {
      const pw = $('auth-pass'); if (pw) pw.value = '';
      return window.LiaCache.status();
    }).then(function (s) {
      if (s.ready) { goScreen('jobs'); renderJobList(); renderSyncStatus(); }
      else goScreen('sync');
    }).catch(function (err) {
      msg('auth-msg', err.message || 'Could not sign in.', true);
    });
  }

  function wire() {
    const si = $('btn-sign-in'); if (si) si.addEventListener('click', signIn);
    const pw = $('auth-pass');
    if (pw) pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
    const ss = $('btn-sync-start'); if (ss) ss.addEventListener('click', startSync);

    // Skipping is allowed, but it must be an informed choice rather than a
    // silent degradation: everything scanned will look like a new item.
    const sl = $('btn-sync-later');
    if (sl) sl.addEventListener('click', function () {
      msg('sync-msg', 'Without the equipment list, every item will look new and will need entering by hand.', true);
      setTimeout(function () { goScreen('jobs'); renderJobList(); renderSyncStatus(); }, 1400);
    });
  }

  function boot() {
    wire();
    const sync = window.LiaSync;
    if (!sync) { goScreen('jobs'); return; }

    sync.startAutoDrain();

    sync.isConfigured().then(function (configured) {
      // A local-only build behaves exactly as it did before sync existed.
      if (!configured) { goScreen('jobs'); return; }
      return sync.session().then(function (sess) {
        if (!sess) { goScreen('auth'); return; }
        return window.LiaCache.status().then(function (s) {
          if (s.ready) { goScreen('jobs'); renderSyncStatus(); }
          else goScreen('sync');
        });
      });
    }).catch(function () { goScreen('jobs'); });
  }

  // openJob is defined in jobs.js; wrap it so every entry point is gated.
  if (typeof window.openJob === 'function') {
    window.openJob = guardJobStart(window.openJob);
  }

  boot();
})();

// ── Settings: refresh and sign out ──────────────────────────────────────────
(function syncSettings() {
  'use strict';

  function show(text, isErr) {
    const el = $('settings-sync-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'auth-msg' + (isErr ? ' err' : '');
  }

  const wrap = $('sync-actions');
  if (wrap && window.LiaSync) {
    window.LiaSync.isConfigured().then(function (c) {
      return c ? window.LiaSync.session() : null;
    }).then(function (sess) {
      wrap.style.display = sess ? 'flex' : 'none';
    }).catch(function () {});
  }

  const refresh = $('btn-refresh-catalog');
  if (refresh) refresh.addEventListener('click', function () {
    refresh.disabled = true;
    show('Refreshing…');
    window.LiaSync.pullCatalog({
      onProgress: function (d, t) { show(t ? `${d} of ${t}…` : 'Refreshing…'); },
    }).then(function (r) {
      show(`${r.total} items on this device.`);
      if (typeof renderSyncStatus === 'function') renderSyncStatus();
    }).catch(function (e) {
      show(e.message || 'Could not refresh.', true);
    }).then(function () { refresh.disabled = false; });
  });

  const out = $('btn-sign-out');
  if (out) out.addEventListener('click', function () {
    // Anything not yet uploaded would be unreachable after the session goes.
    const pending = window.LiaSync ? window.LiaSync.queueLength() : 0;
    if (pending && !confirm(`${pending} record${pending !== 1 ? 's have' : ' has'} not uploaded yet. Sign out anyway?`)) return;
    window.LiaSync.signOut().then(function () {
      if (typeof closeSettings === 'function') closeSettings();
      goScreen('auth');
    });
  });
})();
