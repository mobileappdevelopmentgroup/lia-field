// Lia Field — tag-stock.js
//
// The blank tags this account holds: printed with a number, programmed with a
// link, not yet on any piece of equipment (supabase/migrations/28, 29).
//
// Part of the field app. Classic script — see the note in storage.js.
//
// ── Why the phone needs them ───────────────────────────────────────────────
// A lead's tags arrive already programmed, and the link on the chip is a Google
// Sheet — which, to everything else in this app, looks exactly like somebody
// else's tag. Without this list, tapping one of his own blank tags sends a tech
// down the third-party-link path: "not on file", a sheet to read, a decision
// about a supplier he does not have. With it, the tap says what it is — one of
// ours, not yet on anything — and opens a new item with the tag already on it.
//
// Cached in localStorage and pulled with the catalogue, like the job list: a
// tech in a plant room with no signal still has to recognise his own tags. The
// list is a convenience, never a gate — a miss here only means the tap takes
// the ordinary path.

(function (root) {
  'use strict';

  var KEY = 'lia-tag-stock';

  function serialKey(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Canonical link form, shared with the server's fp_tag_url_key() through
  // tag-link.js. Falls back to a plain lowercase trim, which only costs a miss.
  function urlKey(s) {
    var raw = String(s == null ? '' : s).trim();
    if (!raw) return '';
    var tl = root.LiaTagLink;
    return tl && tl.urlKey ? tl.urlKey(raw) : raw.toLowerCase();
  }

  function looksLikeUrl(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || '').trim());
  }

  function read() {
    try {
      var c = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!c || !Array.isArray(c.tags)) return { tags: [], at: null };
      return c;
    } catch (_) { return { tags: [], at: null }; }
  }

  function write(tags, at) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ tags: tags, at: at || new Date().toISOString() }));
    } catch (_) { /* quota — the list is a convenience, not data at risk */ }
  }

  function set(rows) {
    var tags = (rows || []).filter(function (r) { return r && r.tag_label; }).map(function (r) {
      return { tag_label: String(r.tag_label), tag_url: r.tag_url || '',
               label_key: serialKey(r.tag_label), url_key: urlKey(r.tag_url) };
    });
    write(tags);
    return tags.length;
  }

  function list()      { return read().tags; }
  function fetchedAt() { return read().at; }

  /**
   * The blank tag a value identifies, or null. A link is matched only as a
   * link and a label only as a label: a label typed into the search box must
   * never be run against link keys, and a link must never be stripped down and
   * compared as though it were a printed number.
   */
  function find(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    var tags = list();
    if (looksLikeUrl(v)) {
      var uk = urlKey(v);
      return tags.filter(function (t) { return t.url_key && t.url_key === uk; })[0] || null;
    }
    var lk = serialKey(v);
    return tags.filter(function (t) { return t.label_key && t.label_key === lk; })[0] || null;
  }

  /**
   * Takes a tag out of the local list the moment it is used. The server moves
   * it out of stock when the inspection lands; until then a second tap on the
   * same tag must not offer it as blank again.
   */
  function take(tag) {
    if (!tag) return false;
    var lk = serialKey(tag.tag_label), uk = urlKey(tag.tag_url);
    var c = read();
    var left = c.tags.filter(function (t) {
      return !((lk && t.label_key === lk) || (uk && t.url_key && t.url_key === uk));
    });
    if (left.length === c.tags.length) return false;
    write(left, c.at);
    return true;
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (_) {}
  }

  /** Never rejects: called from the catalogue sync, which must not fail over it. */
  function pull(sb) {
    if (!sb) return Promise.resolve(false);
    return sb.rpc('my_tag_stock').then(function (r) {
      if (r.error || !Array.isArray(r.data)) return false;
      return set(r.data);
    }).catch(function () { return false; });
  }

  var api = { KEY: KEY, set: set, list: list, fetchedAt: fetchedAt, find: find,
              take: take, clear: clear, pull: pull };
  root.LiaTagStock = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
