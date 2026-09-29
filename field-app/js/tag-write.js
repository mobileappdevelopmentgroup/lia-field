// Lia Field — tag-write.js
//
// Writing our own tag onto a piece of fall-protection equipment.
//
// Part of the field app. Classic script — see the note in storage.js.
//
// ── What goes on a tag ─────────────────────────────────────────────────────
// Two NDEF records:
//   a URI record  …/fp/?t=<certificate code>&s=<serial>
//   a text record the serial on its own
//
// and, printed on the tag's face, a human-readable label the tech types in.
//
// That is five ways to the same record — serial, label, chip id, certificate
// code, link — and the point of the feature is that a tech finds the right
// item holding ANY of them. See supabase/17_tag_write.sql for why the URL
// carries the certificate code as well as the serial: a tag riveted to a
// harness cannot be rewritten when the office corrects a mistyped serial, and
// a link carrying only the serial would stop resolving the moment it did.
//
// ── Writing offline ────────────────────────────────────────────────────────
// The whole point of tagging a rack is doing it in a plant room. So the URL is
// built ON THE DEVICE from the cached row, and the server is told afterwards
// through the ordinary upload queue. The one thing that cannot be done offline
// is proving a label is not already on another item — so that check runs when
// there is signal, and when there is not the tech is warned rather than blocked.

(function (root) {
  'use strict';

  // Must match fp_tag_url() in supabase/17_tag_write.sql, or a tag written
  // offline says something different from one written online. Overridable
  // because the base URL is an account setting, not a constant.
  var DEFAULT_BASE = 'https://lia.mobileappdevelopmentgroup.com';
  var BASE_KEY = 'lia-cert-base-url';

  function base() {
    try { return localStorage.getItem(BASE_KEY) || DEFAULT_BASE; }
    catch (_) { return DEFAULT_BASE; }
  }

  function setBase(url) {
    try {
      if (url) localStorage.setItem(BASE_KEY, String(url).replace(/\/+$/, ''));
    } catch (_) {}
  }

  // Percent-encodes everything outside the unreserved set, the same way
  // urlencode_serial() does server-side. encodeURIComponent leaves !'()* alone;
  // those are legal in a query string, but matching the server exactly matters
  // more than being permissive — the two strings are compared.
  function enc(v) {
    return String(v == null ? '' : v).replace(/[^A-Za-z0-9._~-]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    });
  }

  /** The URL that belongs on this item's tag. Null if we cannot make a real one. */
  function urlFor(item) {
    if (!item) return null;
    var ref = item.public_ref;
    if (!ref) return null;
    var serial = item.serial_raw || item.serial_num || '';
    return base() + '/fp/?t=' + ref + (serial ? '&s=' + enc(serial) : '');
  }

  /**
   * Everything about to be written, so the screen can show it before the tech
   * holds a phone against anything. Built locally; the server is not consulted.
   */
  function plan(item, label) {
    var url = urlFor(item);
    return {
      asset_id:   item && item.asset_id,
      serial_num: (item && (item.serial_raw || item.serial_num)) || '',
      public_ref: item && item.public_ref,
      tag_label:  (label || (item && item.tag_label) || '').trim(),
      url:        url,
      prev_label: (item && item.tag_label) || null,
      prev_uid:   (item && item.nfc_tag_uid) || null,
      // A tag already on this item means this is a REPLACEMENT, and the tech
      // should be told so rather than discovering it from the audit trail.
      retag: !!(item && (item.tag_label || item.nfc_tag_uid)),
      ok: !!url,
    };
  }

  /**
   * Is this label already on a different item?
   *
   * Answered from the device cache, which is authoritative enough to catch the
   * common mistake (re-using a label from the same rack) without needing
   * signal. It cannot see a label written by another tech ten minutes ago —
   * that is what the server-side check in record_fp_tag_write is for.
   */
  function labelClash(label, assetId) {
    if (!label || !root.LiaCache || !root.LiaCache.findByLabel) return Promise.resolve(null);
    return root.LiaCache.findByLabel(label).then(function (hit) {
      if (!hit) return null;
      if (assetId && hit.asset_id === assetId) return null;
      return hit;
    }).catch(function () { return null; });
  }

  /**
   * Writes the tag, then records what was written.
   *
   * Ordering is deliberate and is the whole reliability story: the PHYSICAL
   * write happens first, and only a write that actually took is queued. Queuing
   * first would leave the database claiming a tag says something it does not —
   * and nobody re-checks a tag that the system believes is already correct.
   */
  function write(item, label, opts) {
    opts = opts || {};
    var p = plan(item, label);
    if (!p.ok) {
      return Promise.reject(new Error(
        'This item has no certificate code yet. Upload its inspection first, then write its tag.'));
    }
    if (!root.LiaNfc || !root.LiaNfc.write) {
      return Promise.reject(new Error('This device cannot write tags.'));
    }

    return root.LiaNfc.write(p.serial_num, p.url).then(function (res) {
      // The chip id, when the platform hands one back. Not all do, and a write
      // that could not read it is still a good write — the label and the URL
      // identify the tag on their own.
      var uid = (res && (res.uid || res.serialNumber || res.id)) || null;
      var entry = {
        client_id: (root.crypto && crypto.randomUUID)
          ? crypto.randomUUID() : String(Date.now() + Math.random()),
        asset_id:   p.asset_id,
        serial_num: p.serial_num,
        public_ref: p.public_ref,
        tag_label:  p.tag_label || null,
        nfc_tag_uid: uid,
        tag_url:    p.url,
        written_at: new Date().toISOString(),
      };

      if (root.LiaSync && root.LiaSync.enqueue) {
        root.LiaSync.enqueue({ kind: 'fp_tag_write', clientId: entry.client_id, payload: entry });
      }
      // The device believes it immediately, so the tag resolves on this phone
      // even before the queue drains. Without this, a tech who tags a rack in a
      // basement and then taps one to check gets "not registered" back from his
      // own phone, which reads as the write having failed.
      applyLocally(item, entry);

      return { written: true, plan: p, entry: entry };
    });
  }

  // Mirrors what record_fp_tag_write() does server-side, so an offline phone
  // and the database agree about what this item now carries.
  function applyLocally(item, entry) {
    if (!item || !root.LiaCache || !root.LiaCache.put) return;
    var row = {};
    Object.keys(item).forEach(function (k) { row[k] = item[k]; });
    if (entry.tag_label) row.tag_label = entry.tag_label;
    if (entry.nfc_tag_uid) row.nfc_tag_uid = entry.nfc_tag_uid;
    row.tag_url = entry.tag_url;
    try { root.LiaCache.put(row); } catch (_) {}
  }

  var api = {
    urlFor: urlFor,
    plan: plan,
    write: write,
    labelClash: labelClash,
    base: base,
    setBase: setBase,
    _enc: enc,
    _applyLocally: applyLocally,
  };

  root.LiaTagWrite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
