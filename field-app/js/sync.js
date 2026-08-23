// Lia Field — sync.js
//
// Auth, the catalogue pull, and the upload queue. This is the first network code
// the field app has ever had, and the rule it is built around is that capture
// must NEVER depend on connectivity: everything is written locally first and
// uploaded when a connection turns up.
//
// Config is fetched from ./config.json, which is gitignored and written at build
// time. A missing config leaves the app in local-only mode rather than crashing.
//
// Part of the field app. Classic script — see the note in storage.js.

(function (root) {
  'use strict';

  var QUEUE_KEY = 'lia-upload-queue';
  var _client = null;
  var _config = null;
  var _draining = false;

  // ── Client ────────────────────────────────────────────────────────────────

  function loadConfig() {
    if (_config) return Promise.resolve(_config);
    // fetch() cannot read file:// in any browser, so attempting it only logs a
    // console error for a request that was never going to work. The app runs
    // over https or capacitor://localhost in every real deployment; opening the
    // HTML directly is local-only by definition.
    if (root.location && root.location.protocol === 'file:') {
      return Promise.resolve(null);
    }
    return fetch('./config.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (c) {
        _config = c && c.supabase && c.supabase.url ? c : null;
        return _config;
      });
  }

  // Resolves null when the app is not configured for sync, which is a valid
  // state — the app still captures, it just cannot upload.
  function client() {
    if (_client) return Promise.resolve(_client);
    return loadConfig().then(function (c) {
      if (!c || !root.supabase) return null;
      _client = root.supabase.createClient(c.supabase.url, c.supabase.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'lia-field-auth' },
      });
      return _client;
    });
  }

  function isConfigured() {
    return loadConfig().then(function (c) { return !!c; });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  function session() {
    return client().then(function (sb) {
      if (!sb) return null;
      return sb.auth.getSession().then(function (r) { return (r.data && r.data.session) || null; });
    });
  }

  function signIn(email, password) {
    return client().then(function (sb) {
      if (!sb) throw new Error('This build is not configured to sync.');
      return sb.auth.signInWithPassword({ email: email, password: password })
        .then(function (r) {
          if (r.error) throw new Error(r.error.message);
          return r.data.session;
        });
    });
  }

  function signOut() {
    return client().then(function (sb) {
      if (!sb) return null;
      // The catalogue is account data. Leaving it behind would show one
      // company's items to whoever signs in next on the same phone.
      return sb.auth.signOut().then(function () {
        return root.LiaCache ? root.LiaCache.clear() : null;
      });
    });
  }

  function profile() {
    return client().then(function (sb) {
      if (!sb) return null;
      return sb.rpc('get_my_profile').then(function (r) {
        if (r.error) return null;
        return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      });
    });
  }

  // ── Catalogue ─────────────────────────────────────────────────────────────

  function pullCatalog(opts) {
    return client().then(function (sb) {
      if (!sb) throw new Error('This build is not configured to sync.');
      return root.LiaCache.sync(sb, opts || {});
    });
  }

  // ── Upload queue ──────────────────────────────────────────────────────────
  //
  // Captured items go here the moment they are saved, and stay until the server
  // confirms them. A device that never gets signal keeps everything; a device
  // that gets signal drains without the tech doing anything.

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch (_) { return []; }
  }

  function writeQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
    catch (_) { /* quota — the item is still in the job record */ }
  }

  // clientId makes a retry idempotent: the same capture sent twice is one row.
  function enqueue(entry) {
    var q = readQueue();
    q.push({
      clientId: entry.clientId || (root.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
      kind: entry.kind,
      payload: entry.payload,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    });
    writeQueue(q);
    return q.length;
  }

  function queueLength() { return readQueue().length; }

  function pendingSummary() {
    var q = readQueue();
    return {
      total: q.length,
      failing: q.filter(function (e) { return e.attempts >= 3; }).length,
      oldest: q.length ? q[0].queuedAt : null,
    };
  }

  function sendOne(sb, entry) {
    if (entry.kind === 'fall_protection') {
      return sb.rpc('record_fp_inspection', { p: entry.payload });
    }
    if (entry.kind === 'ladder') {
      return sb.rpc('record_inspection', { p: entry.payload });
    }
    return Promise.resolve({ error: { message: 'Unknown record type: ' + entry.kind } });
  }

  // Drains in order and STOPS at the first failure rather than skipping past it.
  // Ploughing on would reorder records and could bury a permanent error behind a
  // growing queue; stopping keeps the failure visible and the order intact.
  function drain(opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    if (_draining) return Promise.resolve({ sent: 0, remaining: queueLength(), busy: true });
    _draining = true;

    return client().then(function (sb) {
      if (!sb) throw new Error('This build is not configured to sync.');
      return sb.auth.getSession().then(function (r) {
        if (!r.data || !r.data.session) throw new Error('Sign in to upload.');
        return sb;
      });
    }).then(function (sb) {
      var sent = 0;

      function step() {
        var q = readQueue();
        if (!q.length) return Promise.resolve();
        var entry = q[0];
        return sendOne(sb, entry).then(function (res) {
          var q2 = readQueue();
          if (res && res.error) {
            entry.attempts = (entry.attempts || 0) + 1;
            entry.lastError = res.error.message;
            q2[0] = entry;
            writeQueue(q2);
            // Never dropped. A record the server rejects is surfaced to the
            // tech, not discarded — losing an inspection silently is worse
            // than a stuck queue.
            throw new Error(res.error.message);
          }
          q2.shift();
          writeQueue(q2);
          sent++;
          onProgress(sent, sent + q2.length);
          return step();
        });
      }

      return step().then(function () {
        return { sent: sent, remaining: queueLength() };
      }).catch(function (err) {
        return { sent: sent, remaining: queueLength(), error: err.message };
      });
    }).catch(function (err) {
      return { sent: 0, remaining: queueLength(), error: err.message };
    }).then(function (out) {
      _draining = false;
      return out;
    });
  }

  // ── Auto-drain ────────────────────────────────────────────────────────────
  // "When they are back on wifi the data gets sent" — without the tech doing
  // anything.

  function startAutoDrain() {
    if (root._liaAutoDrain) return;
    root._liaAutoDrain = true;
    var attempt = function () {
      if (!root.navigator || root.navigator.onLine === false) return;
      if (!queueLength()) return;
      drain({}).then(function (r) {
        if (r && r.sent && typeof root.fpOnUploaded === 'function') root.fpOnUploaded(r);
      });
    };
    root.addEventListener('online', attempt);
    // Coming back from the lock screen is the common case, more so than a real
    // 'online' event.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) attempt();
    });
    setTimeout(attempt, 3000);
    setInterval(attempt, 120000);
  }

  var api = {
    isConfigured: isConfigured,
    client: client,
    session: session,
    signIn: signIn,
    signOut: signOut,
    profile: profile,
    pullCatalog: pullCatalog,
    enqueue: enqueue,
    queueLength: queueLength,
    pendingSummary: pendingSummary,
    drain: drain,
    startAutoDrain: startAutoDrain,
    _readQueue: readQueue,
    _writeQueue: writeQueue,
  };

  root.LiaSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
