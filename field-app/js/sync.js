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
    _uid = null;
    return client().then(function (sb) {
      if (!sb) throw new Error('This build is not configured to sync.');
      return sb.auth.signInWithPassword({ email: email, password: password })
        .then(function (r) {
          if (r.error) throw new Error(r.error.message);
          // Whoever just signed in owns what they capture from here on, and
          // must not inherit the last tech's queue.
          var u = r.data && r.data.session && r.data.session.user;
          _uid = u ? u.id : null;
          _email = u ? (u.email || null) : null;
          return r.data.session;
        });
    });
  }

  function signOut() {
    _uid = null; _email = null;
    // The lead's plan names sites and work orders belonging to one company, so
    // it goes first and unconditionally: a sign-out that could not reach the
    // server, or a build whose client would not construct, must still not leave
    // one company's job list on the phone for whoever signs in next.
    try { localStorage.removeItem('lia-assigned-jobs'); } catch (_) {}
    return client().then(function (sb) {
      if (!sb) return null;
      // The catalogue is account data too, for the same reason.
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
      // The checklists come down with the items. A lead can change a type's
      // pass/fail parameters or add to them at any time, and a phone that
      // syncs its items but not its checklists would keep asking the old
      // questions all day. Small enough to refetch whole every time.
      return pullTypes(sb).then(function () {
        return pullParts(sb);
      }).then(function () {
        return root.LiaCache.sync(sb, opts || {});
      });
    });
  }

  // Never fatal: a stale or built-in checklist still lets a tech work, whereas
  // failing the whole sync over it would strand him with no catalogue at all.
  function pullTypes(sb) {
    if (!root.LiaFpTypes) return Promise.resolve(false);
    return sb.rpc('fp_type_catalog').then(function (r) {
      if (r.error || !r.data) return false;
      var list = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      return root.LiaFpTypes.setCatalog(list);
    }).catch(function () { return false; });
  }

  // The lead's own parts list, picked in Lia Office from what BSI will pay
  // for. Never fatal, for the same reason the checklists are not: a tech with
  // the shipped catalogue can still work; one with no catalogue at all cannot.
  //
  // Merged BEHIND whatever the tech already has — their favourites, the order
  // they put them in, the quantity they set and anything they added by hand.
  // Publishing a catalogue must never rearrange the buttons under somebody's
  // thumb mid-job.
  function pullParts(sb) {
    if (typeof mergeCrewParts !== 'function') return Promise.resolve(false);
    return sb.rpc('account_parts_catalog').then(function (r) {
      if (r.error || !r.data) return false;
      return mergeCrewParts(r.data);
    }).catch(function () { return false; });
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
  // Records used to sit until the two-minute timer, a lock/unlock, or the tech
  // going to Settings. On a job with signal the work should be in the cloud
  // while he is still standing at the rack, so a queued record nudges the
  // drain — debounced, because adding forty ladders in a row should still be
  // one upload rather than forty.
  var _soon = null;
  function uploadSoon(ms) {
    if (_soon) clearTimeout(_soon);
    _soon = setTimeout(function () {
      _soon = null;
      if (root.navigator && root.navigator.onLine === false) return;
      if (!queueLength()) return;
      drain({}).then(function (r) {
        if (r && r.sent && typeof root.fpOnUploaded === 'function') root.fpOnUploaded(r);
      });
    }, ms || 6000);
  }

  // Who captured a record. A phone gets handed between techs, and without this
  // the next person to sign in would upload the last person's queue into their
  // own company's account — work in the wrong place, under the wrong name,
  // billed to the wrong job.
  var _uid = null, _email = null;
  function rememberUser() {
    return session().then(function (s) {
      _uid = s && s.user ? s.user.id : null;
      _email = s && s.user ? (s.user.email || null) : null;
      return _uid;
    }).catch(function () { return null; });
  }
  function currentUid() { return _uid; }
  function currentEmail() { return _email; }
  rememberUser();

  function enqueue(entry) {
    var q = readQueue();
    q.push({
      clientId: entry.clientId || (root.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
      kind: entry.kind,
      payload: entry.payload,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      userId: _uid,          // null on a local-only phone, which is fine
    });
    writeQueue(q);
    uploadSoon();
    return q.length;
  }

  // Pull an entry back out before it is sent. Used when a tap-through pass is
  // undone or reopened to be failed: the record must not reach the server
  // saying it passed, and the drain may not have run yet. A no-op once the
  // entry has already gone up — the drain removes it on success, and by then
  // the correction is a new version rather than a withdrawal.
  function dequeue(clientId) {
    if (!clientId) return false;
    var q = readQueue();
    var out = q.filter(function (e) { return e.clientId !== clientId; });
    if (out.length === q.length) return false;
    writeQueue(out);
    return true;
  }

  function queueLength() { return readQueue().length; }

  // Counts CAPTURED WORK waiting to go up, which is what the badge on the
  // capture screens means. Support traffic is excluded on purpose: a ticket
  // that has not gone yet is not an inspection at risk, and showing it here
  // would tell a tech he has unsent records when he does not.
  // Put records back in the queue. Used by "resend" in Settings, after a run
  // that stopped half way or a record the server never confirmed.
  //
  // It skips anything already queued or already uploaded, deliberately: the
  // write path versions a record rather than rejecting it, so sending a second
  // copy of something that landed would quietly add a superseded row to a
  // customer's certificate history. Resend means "what is missing", not "send
  // it all again".
  function requeue(entries) {
    var already = {};
    readQueue().forEach(function (e) { already[e.clientId] = true; });
    var state = root.LiaSyncState;
    var added = 0;
    (entries || []).forEach(function (e) {
      if (!e || !e.clientId) return;
      if (already[e.clientId]) return;
      if (state && state.sentAt(e.clientId)) return;
      enqueue(e);
      added++;
    });
    return added;
  }

  function pendingSummary() {
    var q = readQueue().filter(function (e) { return !isDeferrable(e); });
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
    // What a tag's hyperlink claimed about an item. Not an inspection — see the
    // header of tag-link.js — so it goes to its own function, which files it as
    // external and never lets it reach fp_inspections.
    if (entry.kind === 'fp_external') {
      return sb.rpc('record_fp_external', { p: entry.payload });
    }
    // A tag seen but not inspected: the link, and whatever identified the tag.
    // Uploading it is what makes the next tap on it resolve, on any phone.
    if (entry.kind === 'fp_tag_link') {
      return sb.rpc('record_fp_tag_link', { p: entry.payload });
    }
    // A tag this tech WROTE. Not optional and not deferrable — see the classes
    // below. The tag is physically on the equipment; if this never lands, the
    // item resolves for nobody but the phone that wrote it, and the next tech
    // to tap it is told the equipment is unregistered.
    if (entry.kind === 'fp_tag_write') {
      return sb.rpc('record_fp_tag_write', { p: entry.payload });
    }
    // Support traffic. Idempotent on client_id at the server, so a retry after a
    // timeout returns the original ticket rather than filing a second one.
    if (entry.kind === 'support_ticket') {
      return sb.rpc('submit_support_ticket', { p: entry.payload });
    }
    if (entry.kind === 'support_reply') {
      return sb.rpc('reply_support_ticket', { p: entry.payload });
    }
    return Promise.resolve({ error: { message: 'Unknown record type: ' + entry.kind } });
  }

  // An inspection is never dropped and never reordered — see drain(). Three
  // kinds of entry, and the difference is what a failure is allowed to cost:
  //
  //   inspections   block the queue on failure. Order and completeness matter
  //                 more than throughput; a rejected record must be seen.
  //   tag writes    treated like an inspection, deliberately. A tag write is a
  //                 change to physical equipment, and a queue that gave up on it
  //                 would leave a tag in the field that only one phone can
  //                 resolve. It blocks, and it is never dropped.
  //   optional      supplementary notes ABOUT an item. Stepped aside, and given
  //                 up on after a few tries — losing a claim off somebody's
  //                 spreadsheet is a far smaller harm than holding a day of real
  //                 inspections off the server. The commonest cause is an app
  //                 shipped ahead of its migration, where the RPC does not exist.
  //   deferrable    support tickets. Also stepped aside — a ticket must never be
  //                 what strands a day's inspections — but NEVER dropped. A tech
  //                 who reported something and was told it went has to be right.
  var OPTIONAL_KINDS = ['fp_external', 'fp_tag_link'];
  var DEFERRABLE_KINDS = ['support_ticket', 'support_reply'];
  var OPTIONAL_ATTEMPTS = 3;

  function isOptional(entry) {
    return OPTIONAL_KINDS.indexOf(entry && entry.kind) >= 0;
  }

  function isDeferrable(entry) {
    return DEFERRABLE_KINDS.indexOf(entry && entry.kind) >= 0;
  }

  // Drains in order and STOPS at the first failure rather than skipping past it.
  // Ploughing on would reorder records and could bury a permanent error behind a
  // growing queue; stopping keeps the failure visible and the order intact.
  // The server has it. This is the only place that knows that, and the only
  // place allowed to say so — see sync-state.js.
  function announceSent(entry) {
    try {
      root.dispatchEvent(new CustomEvent('lia-record-sent', {
        detail: { clientId: entry.clientId, kind: entry.kind },
      }));
    } catch (_) { /* older webview: the queue still shortened */ }
  }

  // Ladders from the front of the queue, up to a batch. Stops at the first
  // entry of any other kind so order is preserved exactly as before.
  var BATCH_MAX = 50;
  function takeLadderBatch(q) {
    var out = [];
    for (var i = 0; i < q.length && out.length < BATCH_MAX; i++) {
      if (q[i].kind !== 'ladder') break;
      // Never mix one tech's records into another's upload.
      if (out.length && q[i].userId !== out[0].userId) break;
      out.push(q[i]);
    }
    return out;
  }

  function sendLadderBatch(sb, batch) {
    return sb.rpc('record_inspections', { p: batch.map(function (e) { return e.payload; }) });
  }

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
      var deferred = 0;

      var parked = {};        // clientIds moved to the back this pass

      function step() {
        var q = readQueue();
        if (!q.length) return Promise.resolve();

        // Consecutive ladders go up as ONE call. A job of forty was forty round
        // trips, each waiting on the last — minutes on a bad signal, and every
        // one of them a chance to be interrupted half way.
        var batch = takeLadderBatch(q);
        if (batch.length > 1) {
          return sendLadderBatch(sb, batch).then(function (res) {
            if (res && res.error) {
              // One bad record must not condemn the other thirty-nine, and the
              // batch cannot say which one it was. Fall back to sending them
              // singly, which isolates the bad one with its own message.
              return stepOne();
            }
            var q2 = readQueue();
            q2.splice(0, batch.length);
            writeQueue(q2);
            sent += batch.length;
            batch.forEach(function (e) { announceSent(e); });
            onProgress(sent, sent + q2.length);
            return step();
          });
        }
        return stepOne();
      }

      function stepOne() {
        var q = readQueue();
        if (!q.length) return Promise.resolve();
        var entry = q[0];
        if (parked[entry.clientId]) return Promise.resolve();   // came round again

        // Somebody else's work. Held, not sent and not dropped: it belongs to
        // the tech who captured it, and uploading it now would file it under
        // whoever happens to be signed in.
        if (entry.userId && _uid && entry.userId !== _uid) {
          var qOther = readQueue();
          qOther.shift();
          qOther.push(entry);
          writeQueue(qOther);
          parked[entry.clientId] = true;
          return step();
        }
        return sendOne(sb, entry).then(function (res) {
          var q2 = readQueue();
          if (res && res.error) {
            entry.attempts = (entry.attempts || 0) + 1;
            entry.lastError = res.error.message;

            // Anything that is not an inspection steps aside rather than
            // blocking. Optional entries are given up on after a few tries;
            // deferrable ones are kept forever, because a tech was told his
            // ticket would be sent.
            if (isOptional(entry) || isDeferrable(entry)) {
              q2.shift();
              if (isDeferrable(entry) || entry.attempts < OPTIONAL_ATTEMPTS) q2.push(entry);
              writeQueue(q2);
              // Bounded by the queue length so a queue of nothing but failing
              // optional entries cannot spin: each pass either drops one or
              // moves it behind something new.
              if (deferred++ >= q2.length) return;
              return step();
            }

            // A record the server keeps refusing used to stop the queue for
            // good: everything behind it waited on something that was never
            // going to be accepted, so a tech with one bad record uploaded
            // nothing all day and the app called it "waiting".
            //
            // It is still never dropped. After three tries it moves to the
            // BACK, the rest of the day's work goes up, and Settings names it
            // with the server's own words.
            if (entry.attempts >= 3) {
              q2.shift();
              q2.push(entry);
              writeQueue(q2);
              parked[entry.clientId] = true;
              return step();
            }

            q2[0] = entry;
            writeQueue(q2);
            throw new Error(res.error.message);
          }
          q2.shift();
          writeQueue(q2);
          sent++;
          announceSent(entry);
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

  // A catalogue pull the device owes because a schema upgrade added a column
  // its existing rows do not carry. It rides the same triggers as the upload
  // queue rather than waiting for a tech to find the Refresh button — he has no
  // way of knowing he owes one, and until it runs a tag's link resolves nothing.
  //
  // Guarded by a flag rather than by the queue, because a full pull of a large
  // account takes long enough for the two-minute timer to fire underneath it.
  var _resyncing = false;

  function catchUpCatalog() {
    if (_resyncing || !root.LiaCache) return;
    root.LiaCache.status().then(function (s) {
      if (_resyncing || !s.needsFullSync) return;
      _resyncing = true;
      return pullCatalog({}).then(function () {
        if (typeof root.renderSyncStatus === 'function') root.renderSyncStatus();
      }).catch(function () {
        // Left flagged on purpose: a pull that failed is still owed, and the
        // next trigger tries again.
      }).then(function () { _resyncing = false; });
    }).catch(function () {});
  }

  // The lead's plan, re-checked when there is signal. Rate-limited rather than
  // run on every trigger: the plan changes a few times a day, the triggers fire
  // every two minutes and on every unlock, and a tech's data allowance is his.
  var ASSIGNMENT_INTERVAL = 10 * 60 * 1000;
  var _assignmentsAt = 0;

  function catchUpAssignments() {
    if (!root.LiaAssignments) return;
    if (Date.now() - _assignmentsAt < ASSIGNMENT_INTERVAL) return;
    _assignmentsAt = Date.now();
    root.LiaAssignments.refresh().then(function (r) {
      // Only redrawn on a real answer — a failed pull must not flicker the
      // list or reset the "as of" line to now.
      if (r && r.ok && typeof root.renderAssignedList === 'function') root.renderAssignedList();
    });
  }

  function startAutoDrain() {
    if (root._liaAutoDrain) return;
    root._liaAutoDrain = true;
    var attempt = function () {
      if (!root.navigator || root.navigator.onLine === false) return;
      catchUpCatalog();
      catchUpAssignments();
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
    rememberUser: rememberUser,
    currentUid: currentUid,
    currentEmail: currentEmail,
    signOut: signOut,
    profile: profile,
    pullCatalog: pullCatalog,
    catchUpCatalog: catchUpCatalog,
    catchUpAssignments: catchUpAssignments,
    pullTypes: pullTypes,
    enqueue: enqueue,
    requeue: requeue,
    uploadSoon: uploadSoon,
    dequeue: dequeue,
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
