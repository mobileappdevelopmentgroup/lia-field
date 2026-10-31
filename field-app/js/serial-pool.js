// Lia Field — serial-pool.js
//
// Numbers for defective equipment that has no tag (supabase/migrations/36).
//
// Part of the field app. Classic script — see the note in storage.js.
//
// ── Why ────────────────────────────────────────────────────────────────────
// A harness found defective with no tag still needs a number to be recorded
// and removed under, and riveting an NFC tag to something about to be thrown
// away wastes the tag. The company keeps a list of assigned numbers that are
// tied to no tag; the office loads it in Lia Office, and "Defective, no tag"
// hands out the next one.
//
// The phone cannot ask the server for "the next number" at the moment of the
// tap — it is in a plant room — and two phones deciding for themselves would
// pick the same one. So while it has signal it RESERVES a few
// (reserve_fp_serials), which nobody else is ever given, and spends them
// offline. A number is spent the moment an item is recorded under it; the
// server agrees once that record uploads, and stops returning it.

(function (root) {
  'use strict';

  var KEY = 'lia-serial-pool';
  var HOLD = 5;

  function serialKey(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function read() {
    try {
      var c = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!c || !Array.isArray(c.serials)) return { serials: [], used: [], at: null };
      if (!Array.isArray(c.used)) c.used = [];
      return c;
    } catch (_) { return { serials: [], used: [], at: null }; }
  }

  function write(c) {
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (_) { /* quota */ }
  }

  // What the server says this phone holds. A number spent here but not yet
  // uploaded is still in the server's list, so "used" is kept — and pruned
  // once the server stops returning it.
  function set(rows, at) {
    var serials = (rows || []).map(function (r) { return String(r && r.serial || '').trim(); })
                              .filter(Boolean);
    var keys = serials.map(serialKey);
    var c = read();
    var used = c.used.filter(function (k) { return keys.indexOf(k) >= 0; });
    write({ serials: serials, used: used, at: at || new Date().toISOString() });
    return true;
  }

  function available() {
    var c = read();
    return c.serials.filter(function (s) { return c.used.indexOf(serialKey(s)) < 0; });
  }

  function next() { return available()[0] || null; }

  // Called for every recorded item; a serial that is not one of ours is a no-op.
  function markUsed(serial) {
    var k = serialKey(serial);
    if (!k) return false;
    var c = read();
    var mine = c.serials.some(function (s) { return serialKey(s) === k; });
    if (!mine || c.used.indexOf(k) >= 0) return false;
    c.used.push(k);
    write(c);
    return true;
  }

  function fetchedAt() { return read().at; }
  function hasAny() { return read().serials.length > 0; }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (_) {}
  }

  /** Never rejects: called from the catalogue sync, which must not fail over it. */
  function pull(sb) {
    if (!sb) return Promise.resolve(false);
    return sb.rpc('reserve_fp_serials', { p_count: HOLD }).then(function (r) {
      if (r.error || !Array.isArray(r.data)) return false;
      return set(r.data);
    }).catch(function () { return false; });
  }

  var api = { KEY: KEY, set: set, available: available, next: next, markUsed: markUsed,
              fetchedAt: fetchedAt, hasAny: hasAny, clear: clear, pull: pull };
  root.LiaSerialPool = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
