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
      // An app update added a column the stored rows do not carry, so the device
      // owes one full pull. It is queued and runs on its own the next time there
      // is signal — say so rather than showing a reassuring "synced today" for a
      // catalogue that is a column short.
      if (s.needsFullSync) {
        el.textContent = `${s.count} items · updating when you have signal`;
        el.className = 'sync-status stale';
        return;
      }
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
      markAuthOffered();
      const pw = $('auth-pass'); if (pw) pw.value = '';
      return window.LiaCache.status();
    }).then(function (s) {
      refreshAssignments();
      if (s.ready) { goScreen('jobs'); renderJobList(); renderSyncStatus(); }
      else goScreen('sync');
    }).catch(function (err) {
      msg('auth-msg', err.message || 'Could not sign in.', true);
    });
  }

  function wire() {
    const si = $('btn-sign-in'); if (si) si.addEventListener('click', signIn);

    // Working locally is a choice this app supports, so it is a button and not
    // a dead end: the offer is remembered, the app opens, and Settings keeps
    // the way back for the day they want their work uploaded.
    const wo = $('btn-work-offline');
    if (wo) wo.addEventListener('click', function () {
      markAuthOffered();
      goScreen('jobs');
      if (typeof renderJobList === 'function') renderJobList();
      if (typeof renderSyncStatus === 'function') renderSyncStatus();
    });
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

  // The lead's plan for the day, checked on every start.
  //
  // Deliberately NOT awaited by anything and deliberately unable to fail: it
  // runs alongside the screen decision, and when there is no signal the app
  // carries on with the list it already had. A tech standing in a plant room
  // must not be looking at a spinner because the office network is down.
  function refreshAssignments() {
    if (!window.LiaAssignments) return;
    window.LiaAssignments.refresh().then(function () {
      if (typeof renderAssignedList === 'function') renderAssignedList();
      if (typeof renderJobList === 'function') renderJobList();
    });
  }
  window.refreshAssignments = refreshAssignments;

  // Has this phone been offered the sign-in screen yet? Offered ONCE, then
  // never again unprompted: a tech who chose to work locally should not be
  // asked every morning, and Settings carries the way back.
  function authOffered() {
    try { return localStorage.getItem('lia-auth-offered') === '1'; }
    catch (_) { return false; }   // private mode, blocked storage: offer it
  }
  function markAuthOffered() {
    try { localStorage.setItem('lia-auth-offered', '1'); } catch (_) {}
  }
  window.markAuthOffered = markAuthOffered;

  function boot() {
    wire();
    const sync = window.LiaSync;
    if (!sync) { goScreen('jobs'); return; }

    sync.startAutoDrain();

    sync.isConfigured().then(function (configured) {
      // A local-only build behaves exactly as it did before sync existed.
      if (!configured) { goScreen('jobs'); return; }
      return sync.session().then(function (sess) {
        // Signing in is OPTIONAL. A tech who wants to log on this phone and
        // hand the office a CSV is using the app as intended, so a missing
        // session opens the app rather than blocking it. The sign-in screen is
        // offered once, on a phone that has never had a session, and after
        // that lives in Settings — see signInAffordance() below.
        if (!sess) { goScreen(authOffered() ? 'jobs' : 'auth'); return; }
        refreshAssignments();
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

  // Offered in Settings whenever this phone could sync but nobody is signed in.
  function signInAffordance() {
    const box = $('signin-actions');
    if (!box || !window.LiaSync) return;
    window.LiaSync.isConfigured().then(function (c) {
      if (!c) return null;                       // a local-only build: nothing to offer
      return window.LiaSync.session();
    }).then(function (sess) {
      const show = sess === null;
      box.style.display = show ? 'flex' : 'none';
      if (!show) return;
      // What signing in would actually do for them, in records rather than
      // promises: a tech with 40 waiting has a reason, one with none does not.
      const n = window.LiaSync.queueLength();
      const note = $('signin-pending');
      if (note) {
        note.textContent = n
          ? `${n} record${n !== 1 ? 's' : ''} logged on this phone would upload.`
          : 'Upload your work instead of sharing a CSV.';
      }
    }).catch(function () {});
  }
  window.refreshSignInAffordance = signInAffordance;
  signInAffordance();

  const go = $('btn-go-signin');
  if (go) go.addEventListener('click', function () {
    if (typeof closeSettings === 'function') closeSettings();
    goScreen('auth');
  });

  // ── What this device still owes the server ────────────────────────────────
  function renderUploadState() {
    const el = $('upload-state');
    if (!el || !window.LiaSync || !window.LiaSync.pendingSummary) return;
    const p = window.LiaSync.pendingSummary();
    if (!p.total) {
      el.textContent = 'Everything recorded on this phone is on the server.';
      el.className = 'auth-sub';
      return;
    }
    const age = p.oldest ? Math.floor((Date.now() - new Date(p.oldest)) / 3600000) : 0;
    el.className = 'auth-msg' + (p.failing ? ' err' : '');
    el.textContent = p.failing
      ? `${p.total} waiting · ${p.failing} the server keeps refusing.`
      : `${p.total} waiting to upload${age >= 1 ? `, oldest ${age}h ago` : ''}.`;
  }
  window.renderUploadState = renderUploadState;
  renderUploadState();

  const redown = $('btn-redownload-catalog');
  if (redown) redown.addEventListener('click', function () {
    redown.disabled = true;
    show('Downloading the whole list…');
    window.LiaSync.pullCatalog({
      full: true,
      onProgress: function (d, t) { show(t ? `${d} of ${t}…` : 'Downloading…'); },
    }).then(function (r) {
      show(`${r.total} items on this device.`);
      if (typeof renderSyncStatus === 'function') renderSyncStatus();
    }).catch(function (e) {
      show(e.message || 'Could not download it.', true);
    }).then(function () { redown.disabled = false; });
  });

  const upNow = $('btn-upload-now');
  if (upNow) upNow.addEventListener('click', function () {
    upNow.disabled = true;
    show('Uploading…');
    window.LiaSync.drain({ onProgress: function (s2, t) { show(`${s2} of ${t}…`); } })
      .then(function (r) {
        // The server's own words when it refuses: a tech reading "not going
        // through" learns nothing, and the lead they ring learns less.
        show(r.error ? (r.error + (r.sent ? ` (${r.sent} did go up)` : ''))
                     : (r.sent ? `${r.sent} uploaded.` : 'Nothing was waiting.'), !!r.error);
        renderUploadState();
        renderWaiting();
        if (typeof renderPending === 'function') renderPending();
      })
      .then(function () { upNow.disabled = false; });
  });

  // Re-sending means "send what is missing", never "send it all again": the
  // write path versions a record rather than rejecting it, so a second copy of
  // something that already landed would add a superseded row to a customer's
  // certificate history.
  function resend(records, what) {
    const entries = records.filter(Boolean);
    if (!entries.length) { show('Nothing to re-send.'); return; }
    const added = window.LiaSync.requeue(entries);
    renderUploadState();
    if (typeof renderPending === 'function') renderPending();
    if (!added) { show(`${what} is already on the server.`); return; }
    show(`${added} queued. Uploading…`);
    window.LiaSync.drain({}).then(function (r) {
      show(r.error ? r.error : `${r.sent} uploaded.`, !!r.error);
      renderUploadState();
      renderWaiting();
    });
  }

  const rsJob = $('btn-resend-job');
  if (rsJob) rsJob.addEventListener('click', function () {
    const job = (typeof _job !== 'undefined' && _job) ? _job : null;
    if (!job) { show('Open a job first, then re-send it.', true); return; }
    resend(jobEntries(job), job.workOrderNum ? `WO ${job.workOrderNum}` : 'That job');
  });

  const rsAll = $('btn-resend-all');
  if (rsAll) rsAll.addEventListener('click', function () {
    let all = [];
    try {
      Object.values(loadJobs()).forEach(function (j) { all = all.concat(jobEntries(j)); });
    } catch (_) { /* fall through to the empty case */ }
    resend(all, 'Everything on this phone');
  });

  // Every record in a job, in the shape the queue takes. Ladders need the job
  // for their work order, which is why this lives here rather than in the
  // capture screens.
  function jobEntries(job) {
    const out = [];
    (job.ladders || []).forEach(function (l) {
      if (!l.serialNum || !job.workOrderNum) return;
      out.push({
        clientId: l.id,
        kind: 'ladder',
        payload: {
          serial_num: l.serialNum,
          work_order_id: job.workOrderNum,
          brand: l.brand || undefined,
          type: l.type || undefined,
          length: l.length || undefined,
          notes: l.desc || undefined,
          source: 'field',
          captured_at: l.capturedAt || undefined,
        },
      });
    });
    (job.items || []).forEach(function (it) {
      if (typeof fpToPayload !== 'function') return;
      out.push({ clientId: it.id, kind: 'fall_protection', payload: fpToPayload(it) });
    });
    return out;
  }

  function renderWaiting() {
    const box = $('waiting-list');
    if (!box || !window.LiaSyncState) return;
    if (box.style.display === 'none') return;
    const rows = window.LiaSyncState.waiting();
    if (!rows.length) {
      box.innerHTML = '<div class="wait-row"><span class="wr-sn">Nothing waiting</span></div>';
      return;
    }
    box.innerHTML = rows.map(function (r) {
      const bad = r.attempts >= 3;
      const why = bad ? (r.lastError || 'the server keeps refusing it')
                      : (r.workOrder ? 'WO ' + r.workOrder : 'waiting');
      return '<div class="wait-row' + (bad ? ' bad' : '') + '">' +
             '<span class="wr-sn">' + esc(r.label) + '</span>' +
             '<span class="wr-meta">' + esc(why) + '</span></div>';
    }).join('');
  }

  const showWaiting = $('btn-show-waiting');
  if (showWaiting) showWaiting.addEventListener('click', function () {
    const box = $('waiting-list');
    const open = box.style.display !== 'none';
    box.style.display = open ? 'none' : 'block';
    showWaiting.textContent = open ? 'Show what is waiting' : 'Hide what is waiting';
    renderWaiting();
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
