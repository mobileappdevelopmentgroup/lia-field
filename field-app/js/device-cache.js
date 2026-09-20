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
  var DB_VERSION = 4;
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

  // The certificate code an NFC tag's URL carries (?t=<public_ref>). Generated
  // by gen_public_ref() in supabase/04_inspections_v2.sql from a vowel-free
  // base32 alphabet, so it arrives already normalized; this only has to undo
  // whatever a tag or a human put around it.
  function refKey(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // The hyperlink a tag carries. Most tags on a customer's existing rack were
  // written by whoever supplied the gear and point into their system, not ours —
  // no serial, no certificate code, just a link. Once that link has been seen on
  // an item it identifies it as well as anything else does, so it is indexed.
  //
  // Canonicalization lives in tag-link.js so that the device and the server
  // agree on when two links are the same link; this falls back to a plain
  // lowercase trim if that file has not loaded, which only costs a miss.
  function urlKey(s) {
    var raw = String(s == null ? '' : s).trim();
    if (!raw) return '';
    var tl = root.LiaTagLink;
    return tl && tl.urlKey ? tl.urlKey(raw) : raw.toLowerCase();
  }

  function looksLikeUrl(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || '').trim());
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
        var s;
        if (!db.objectStoreNames.contains(STORE)) {
          s = db.createObjectStore(STORE, { keyPath: 'asset_id' });
          // Four ways in, because a tech has four ways to identify an item.
          s.createIndex('by_serial', 'serial_key', { unique: false });
          s.createIndex('by_tag', 'tag_key', { unique: false });
          s.createIndex('by_kind', 'kind', { unique: false });
        } else {
          s = e.target.transaction.objectStore(STORE);
        }
        // v2 — the certificate code. Indexed on public_ref directly rather than
        // on a normalized copy, because the server generates it already
        // normalized: that means devices upgrading from v1 get their existing
        // rows indexed by IndexedDB itself, with no backfill and no re-sync.
        if (!s.indexNames.contains('by_ref')) {
          s.createIndex('by_ref', 'public_ref', { unique: false });
        }
        // v3 — the tag's hyperlink. Unlike public_ref this one DOES need a
        // normalized copy (the same link is written a dozen ways), so a device
        // upgrading from v2 has rows with no tag_url_key until its next sync.
        // That is a miss, not a fault: the item still resolves by serial or uid,
        // and the key lands the moment the row is refreshed.
        if (!s.indexNames.contains('by_url')) {
          s.createIndex('by_url', 'tag_url_key', { unique: false });
        }
        // v4 — the label printed on the tag itself. Not the same thing as the
        // serial: the serial belongs to the equipment, the label belongs to the
        // tag stuck on it, and a harness can outlive three tags. A tech holding
        // either one has to get the record. Needs a normalized copy for the
        // same reason the serial does, so v3 rows carry none until they resync.
        if (!s.indexNames.contains('by_label')) {
          s.createIndex('by_label', 'tag_label_key', { unique: false });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' });
        }
        // Adding the index is not enough to make it useful: rows already on the
        // device were synced before the server had a tag_url to send, so every
        // one of them indexes as empty. The incremental sync would never revisit
        // them — `since` has moved past — and the link lookup would quietly work
        // only for items touched after the upgrade.
        //
        // A full pull is the only thing that backfills it. But the mark is NOT
        // cleared to force one: `since` and `at` are what requireFirstSync reads,
        // and blanking them would lock a tech out of starting a job because his
        // phone happened to update at a customer's site. The catalogue he has is
        // still good — it is one column short. So the need is flagged separately,
        // and honoured on the next sync he is online for.
        if (e.oldVersion && e.oldVersion < 4 && db.objectStoreNames.contains(META)) {
          try {
            var ms = e.target.transaction.objectStore(META);
            var mreq = ms.get('sync');
            mreq.onsuccess = function () {
              var m = mreq.result;
              if (!m) return;
              m.needsFullSync = true;
              ms.put(m);
            };
          } catch (_) {}
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
      // A schema upgrade that added a column nobody has yet: ignore the mark for
      // this one pull so every row comes back and gets it. Cleared only once the
      // pull has finished, so an interrupted one runs again rather than leaving
      // half the catalogue without its link.
      // opts.full: the tech asked for everything again in Settings. Something
      // looked wrong or missing, and "trust the bookmark" is exactly what they
      // are trying to get past.
      if (meta.needsFullSync || opts.full) meta.since = null;
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
              row.tag_url_key = urlKey(row.tag_url);
              // Normalized with serialKey, not tagKey: a label is printed
              // alphanumerics like a serial, not hex like a chip id.
              row.tag_label_key = serialKey(row.tag_label);
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
        // needsFullSync is not carried into the new meta — putMeta writes a
        // fresh object, so getting this far clears the flag by construction.
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

  // A tag whose only record is the certificate URL identifies the item by its
  // public_ref, not by a serial the cache has ever seen. Tried last, and after
  // the serial, so that a real serial always wins if one ever collides with a
  // ref.
  function findByRef(ref) {
    var k = refKey(ref);
    if (!k) return Promise.resolve(null);
    return open().then(function (db) { return firstFromIndex(db, 'by_ref', k); })
      .then(function (r) { return r || null; });
  }

  // The code printed on the tag in the tech's hand. Tried after the serial,
  // because a serial is the equipment's own identity and must win any collision
  // — a label is only ever a pointer to it.
  function findByLabel(label) {
    var k = serialKey(label);
    if (!k) return Promise.resolve(null);
    return open().then(function (db) { return firstFromIndex(db, 'by_label', k); })
      .then(function (r) { return r || null; });
  }

  // A tag whose link points into somebody else's system — the common case on a
  // rack the customer already owned. There is no serial in it and no ref, so the
  // link itself is the handle, matched on the canonical form so that the same
  // link written two ways still resolves to one item.
  function findByUrl(url) {
    var k = urlKey(url);
    if (!k) return Promise.resolve(null);
    return open().then(function (db) { return firstFromIndex(db, 'by_url', k); })
      .then(function (r) { return r || null; });
  }

  // Anything the tech might have in hand.
  //
  // A URL is dispatched straight to the link index rather than run through the
  // other three. tagKey() strips a link down to whichever letters happen to be
  // hex — 'https://acme.example/EF/12' becomes 'EFEACEEE' — and that is a key
  // that can collide with a real tag uid. Guessing wrong here does not fail
  // safely: it returns the WRONG ITEM's record, on fall protection.
  function find(value, kind) {
    if (looksLikeUrl(value)) {
      return findByUrl(value).then(function (hit) {
        // A certificate link is ours and still resolves by what is inside it,
        // even on a phone that has never seen this particular tag. Our links
        // carry both a certificate code and the serial — see 17_tag_write.sql
        // for why both — so either gets there.
        if (hit) return hit;
        var tl = root.LiaTagLink;
        if (!tl) return null;
        var ref = tl.refFrom ? tl.refFrom(value) : null;
        return (ref ? findByRef(ref) : Promise.resolve(null)).then(function (h) {
          if (h) return h;
          var sn = tl.serialFrom ? tl.serialFrom(value) : null;
          return sn ? findBySerial(sn, kind) : null;
        });
      });
    }
    return findByTag(value).then(function (hit) {
      return hit || findBySerial(value, kind);
    }).then(function (hit) {
      return hit || findByLabel(value);
    }).then(function (hit) {
      return hit || findByRef(value);
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
          // Set by a schema upgrade that added a column the existing rows do
          // not carry. Exposed so the app can run that pull on its own rather
          // than waiting for a tech to think of it — see startAutoDrain().
          needsFullSync: !!meta.needsFullSync,
        };
      });
    }).catch(function () {
      return { ready: false, count: 0, lastSyncAt: null, since: null, needsFullSync: false };
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

  // Writes one row straight into the cache, keys and all.
  //
  // Used when the DEVICE learns something before the server does — writing a
  // tag is the case: the tech tags a rack in a basement, and if the cache did
  // not learn the new label immediately, tapping one of those tags to check his
  // work would come back "not registered" off his own phone. That reads as the
  // write having failed, and he re-writes a tag that was already correct.
  //
  // Overwritten by the next sync, which is the right precedence: the server is
  // the authority, this is only bridging the gap until the queue drains.
  function put(row) {
    if (!row || !row.asset_id) return Promise.resolve(false);
    var r = {};
    Object.keys(row).forEach(function (k) { r[k] = row[k]; });
    r.serial_key = serialKey(r.serial_raw || r.serial_key);
    r.tag_key = tagKey(r.nfc_tag_uid);
    r.tag_url_key = urlKey(r.tag_url);
    r.tag_label_key = serialKey(r.tag_label);
    return open().then(function (db) {
      return tx(db, STORE, 'readwrite', function (store) { store.put(r); });
    }).then(function () { return true; }).catch(function () { return false; });
  }

  var api = {
    put: put,
    serialKey: serialKey,
    tagKey: tagKey,
    refKey: refKey,
    urlKey: urlKey,
    sync: sync,
    find: find,
    findByTag: findByTag,
    findByLabel: findByLabel,
    findBySerial: findBySerial,
    findByRef: findByRef,
    findByUrl: findByUrl,
    status: status,
    requireFirstSync: requireFirstSync,
    clear: clear,
  };

  root.LiaCache = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
