// Lia Field — on-device catalogue cache.
//
// Every item the account has ever inspected, stored locally, so that tapping an
// NFC tag / scanning a barcode / typing a serial brings last year's record
// straight up instead of a blank form. Most of these items have been inspected
// for years; re-entering them was the work this removes.
//
// IndexedDB, not localStorage: localStorage caps around 5 MB per origin and
// throws a quota error most code paths swallow. A 100k-item account is ~22 MB.
//
// No framework, no build step — same constraints as the rest of the field app.
// Exposed as window.LiaCache, and as a CommonJS export so it can be tested.

(function (root) {
  'use strict';

  var DB_NAME = 'lia-field';
  var DB_VERSION = 1;
  var STORE = 'assets';
  var META = 'meta';

  // Serials get typed, scanned and printed inconsistently. Match on the
  // normalized form; keep the raw one for display. MUST stay identical to
  // serial_key() in supabase/04_inspections_v2.sql, or a tap finds nothing.
  function serialKey(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // NFC tag ids come off the hardware in several shapes (04:A1:B2:C3,
  // 04-a1-b2-c3, 04A1B2C3). Normalize the same way so a tap always resolves.
  function tagKey(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-F0-9]/g, '');
  }

  function open() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) {
        reject(new Error('This device has no offline storage available.'));
        return;
      }
      var req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var s = db.createObjectStore(STORE, { keyPath: 'asset_id' });
          // Three ways in, because a tech has three ways to identify an item.
          s.createIndex('by_serial', 'serial_key', { unique: false });
          s.createIndex('by_tag', 'tag_key', { unique: false });
          s.createIndex('by_kind', 'kind', { unique: false });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode);
      var out = fn(t.objectStore(store));
      t.oncomplete = function () { resolve(out && out.__box ? out.value : out); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('Storage transaction aborted')); };
    });
  }

  // Marked so an absent result resolves as null rather than leaking this box.
  // Without the marker an unknown tag came back as a truthy {}, so a lookup
  // "succeeded" with an empty record instead of falling through to "not on file".
  function reqValue(req) {
    var box = { __box: true, value: null };
    req.onsuccess = function () { box.value = req.result === undefined ? null : req.result; };
    return box;
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  function getMeta(db) {
    return tx(db, META, 'readonly', function (s) { return reqValue(s.get('sync')); })
      .then(function (v) { return v || { key: 'sync', since: null, at: null, count: 0 }; });
  }

  function putMeta(db, meta) {
    meta.key = 'sync';
    return tx(db, META, 'readwrite', function (s) { s.put(meta); });
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  // Pull the account's catalogue down. Pass a Supabase client. `onProgress` is
  // called with (done, total) so a first sync can show progress rather than a
  // blank wait.
  //
  // The first sync is deliberately all-or-nothing: `since` is only advanced once
  // every page has landed. A half-finished sync that recorded its mark would
  // leave the device permanently missing whatever it did not reach.
  function sync(sb, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var db, meta, total = 0, done = 0;

    return open().then(function (d) {
      db = d;
      return getMeta(db);
    }).then(function (m) {
      meta = m;
      return sb.rpc('account_snapshot_meta', { p_since: meta.since });
    }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      var info = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      total = info.changed || 0;
      onProgress(0, total);

      var nextSince = info.next_since;
      var afterUpdated = null, afterId = null;

      function page() {
        return sb.rpc('account_snapshot', {
          p_since: meta.since,
          p_limit: 1000,
          p_after_updated: afterUpdated,
          p_after_id: afterId,
        }).then(function (r) {
          if (r.error) throw new Error(r.error.message);
          var rows = r.data || [];
          if (!rows.length) return null;

          return tx(db, STORE, 'readwrite', function (store) {
            rows.forEach(function (row) {
              // A deleted item is removed outright rather than left to shadow a
              // later re-registration of the same serial.
              if (row.is_deleted) { store.delete(row.asset_id); return; }
              row.serial_key = serialKey(row.serial_raw || row.serial_key);
              row.tag_key = tagKey(row.nfc_tag_uid);
              store.put(row);
            });
          }).then(function () {
            done += rows.length;
            onProgress(done, total);
            var last = rows[rows.length - 1];
            afterUpdated = last.updated_at;
            afterId = last.asset_id;
            return rows.length < 1000 ? null : page();
          });
        });
      }

      return page().then(function () {
        // Only now is the mark safe to advance.
        return count(db).then(function (n) {
          return putMeta(db, { since: nextSince, at: new Date().toISOString(), count: n })
            .then(function () { return { synced: done, total: n }; });
        });
      });
    });
  }

  function count(db) {
    return tx(db, STORE, 'readonly', function (s) { return reqValue(s.count()); });
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  function firstFromIndex(db, index, key) {
    return tx(db, STORE, 'readonly', function (s) {
      return reqValue(s.index(index).get(key));
    });
  }

  // The three ways a tech identifies an item, in the order they are cheapest:
  // an NFC tap, a scanned or typed serial.
  function findByTag(uid) {
    var k = tagKey(uid);
    if (!k) return Promise.resolve(null);
    return open().then(function (db) { return firstFromIndex(db, 'by_tag', k); })
      .then(function (r) { return r || null; });
  }

  function findBySerial(serial, kind) {
    var k = serialKey(serial);
    if (!k) return Promise.resolve(null);
    return open().then(function (db) {
      return tx(db, STORE, 'readonly', function (s) {
        var box = { __box: true, value: null };
        var req = s.index('by_serial').getAll(k);
        req.onsuccess = function () {
          var rows = req.result || [];
          // A ladder and a fall-protection item may legitimately share a serial,
          // so the caller's scope decides which one is meant.
          box.value = kind ? (rows.filter(function (r) { return r.kind === kind; })[0] || null)
                           : (rows[0] || null);
        };
        return box;
      });
    });
  }

  // Anything the tech might have in hand.
  function find(value, kind) {
    return findByTag(value).then(function (hit) {
      return hit || findBySerial(value, kind);
    });
  }

  // ── State ─────────────────────────────────────────────────────────────────

  function status() {
    return open().then(function (db) {
      return Promise.all([getMeta(db), count(db)]).then(function (r) {
        var meta = r[0], n = r[1];
        return {
          ready: !!meta.since && n >= 0 && meta.at != null,
          count: n,
          lastSyncAt: meta.at,
          since: meta.since,
        };
      });
    }).catch(function () {
      return { ready: false, count: 0, lastSyncAt: null, since: null };
    });
  }

  // A tech who installs the app in a dead zone and drives to a site would
  // otherwise have an empty cache and be back to typing everything — and worse,
  // every item would look new. So a job cannot be started until the catalogue
  // has come down at least once.
  function requireFirstSync() {
    return status().then(function (s) {
      if (!s.ready) {
        var e = new Error('Connect to wifi or data and sync before starting a job. ' +
                          'Without the catalogue, saved items will look like new ones.');
        e.code = 'NO_FIRST_SYNC';
        throw e;
      }
      return s;
    });
  }

  function clear() {
    return open().then(function (db) {
      return Promise.all([
        tx(db, STORE, 'readwrite', function (s) { s.clear(); }),
        tx(db, META, 'readwrite', function (s) { s.clear(); }),
      ]);
    });
  }

  var api = {
    serialKey: serialKey,
    tagKey: tagKey,
    sync: sync,
    find: find,
    findByTag: findByTag,
    findBySerial: findBySerial,
    status: status,
    requireFirstSync: requireFirstSync,
    clear: clear,
  };

  root.LiaCache = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
