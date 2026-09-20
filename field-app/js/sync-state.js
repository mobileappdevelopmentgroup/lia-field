// Which records have reached the server, and which are still waiting.
//
// The queue already knew this, but only as a NUMBER — "7 waiting to upload" —
// which is no use to a tech looking at a list of forty ladders wondering which
// three have not landed. And once the queue drained, nothing said a record had
// arrived either; it simply stopped being counted.
//
// So each record carries its own answer:
//
//   uploaded   the server has it, and said so
//   waiting    it is in the queue
//   failing    it is in the queue and has been refused three times or more
//   local      this device does not sync at all, or nobody is signed in
//
// The mark is written when the SERVER confirms, never when the app sends. A
// record marked uploaded because a request left the phone is exactly the lie
// this app is built not to tell.
(function (root) {
  'use strict';

  var SENT_KEY = 'lia-sent-records';   // clientId -> ISO time the server confirmed
  var MAX_SENT = 4000;                 // trimmed oldest-first; a year of heavy use

  function readSent() {
    try { return JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function writeSent(map) {
    try { localStorage.setItem(SENT_KEY, JSON.stringify(map)); }
    catch (_) { /* full or blocked: the queue is still the source of truth */ }
  }

  function markSent(clientId) {
    if (!clientId) return;
    var map = readSent();
    if (map[clientId]) return;
    map[clientId] = new Date().toISOString();

    var keys = Object.keys(map);
    if (keys.length > MAX_SENT) {
      keys.sort(function (a, b) { return map[a] < map[b] ? -1 : 1; });
      keys.slice(0, keys.length - MAX_SENT).forEach(function (k) { delete map[k]; });
    }
    writeSent(map);
  }

  function sentAt(clientId) { return readSent()[clientId] || null; }

  // Editing a record makes the confirmed copy stale: the server holds the old
  // values until the new ones land, so it goes back to "waiting".
  function markUnsent(clientId) {
    if (!clientId) return;
    var map = readSent();
    if (!map[clientId]) return;
    delete map[clientId];
    writeSent(map);
  }

  // The queue, indexed. Read fresh each time: it changes under us as the drain
  // runs, and a cached copy is how a screen ends up showing "waiting" for
  // something that landed a minute ago.
  function queued() {
    var out = {};
    if (!root.LiaSync || !root.LiaSync._readQueue) return out;
    try {
      root.LiaSync._readQueue().forEach(function (e) {
        out[e.clientId] = { attempts: e.attempts || 0, kind: e.kind, lastError: e.lastError || null };
      });
    } catch (_) { /* treat as empty */ }
    return out;
  }

  // Whether this device uploads at all. A standalone phone should show no
  // upload marks whatsoever — a grey "local" pill on every line is noise
  // about a thing the tech has chosen not to use.
  var _syncs = null;
  function syncing() {
    if (_syncs !== null) return Promise.resolve(_syncs);
    if (!root.LiaSync) { _syncs = false; return Promise.resolve(false); }
    return root.LiaSync.isConfigured().then(function (c) {
      if (!c) { _syncs = false; return false; }
      return root.LiaSync.session().then(function (s) { _syncs = !!s; return _syncs; });
    }).catch(function () { _syncs = false; return false; });
  }
  function forgetSyncing() { _syncs = null; }   // after signing in or out

  function stateOf(clientId, q) {
    q = q || queued();
    if (sentAt(clientId)) return 'uploaded';
    var e = q[clientId];
    if (!e) return 'local';
    return e.attempts >= 3 ? 'failing' : 'waiting';
  }

  // One badge, used by both lists. Nothing is drawn for a record that has no
  // business having a mark.
  function badge(clientId, q) {
    var s = stateOf(clientId, q);
    if (s === 'local') return '';
    if (s === 'uploaded') return '<span class="up up-ok" title="On the server">✓</span>';
    if (s === 'failing') return '<span class="up up-bad" title="Not going through — open Settings">!</span>';
    return '<span class="up up-wait" title="Waiting to upload">•</span>';
  }

  // Everything still owed, oldest first, with enough to name it on screen.
  function waiting() {
    if (!root.LiaSync || !root.LiaSync._readQueue) return [];
    try {
      return root.LiaSync._readQueue().map(function (e) {
        var p = e.payload || {};
        return {
          clientId: e.clientId,
          kind: e.kind,
          attempts: e.attempts || 0,
          lastError: e.lastError || null,
          queuedAt: e.queuedAt,
          label: p.serial_num || p.serial || p.subject || e.kind,
          workOrder: p.work_order_id || null,
        };
      });
    } catch (_) { return []; }
  }

  // The server confirmed one. Wired in sync.js, which is the only place that
  // knows a send actually succeeded.
  root.addEventListener('lia-record-sent', function (ev) {
    markSent(ev.detail && ev.detail.clientId);
  });

  root.LiaSyncState = {
    markSent: markSent,
    markUnsent: markUnsent,
    sentAt: sentAt,
    stateOf: stateOf,
    badge: badge,
    queued: queued,
    waiting: waiting,
    syncing: syncing,
    forgetSyncing: forgetSyncing,
  };
})(typeof window !== 'undefined' ? window : globalThis);
