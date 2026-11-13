// Lia Field — serial-check.js
//
// Refuses words typed into the serial field in place of a serial.
//
// Part of the field app. Classic script — see the note in storage.js.
//
// ── Why ────────────────────────────────────────────────────────────────────
// A lanyard with no serial was recorded as "N/A" (2026-10-28). The server keys
// an item on its serial, so that is not just an ugly certificate: the next item
// anybody records as "N/A" in the same account is matched to the lanyard and
// recorded against it, and two items' histories become one. A blank serial was
// already refused; this refuses the things people type to mean blank.
//
// Matching is on the same key the server uses (upper case, letters and digits
// only), so "n/a", "N.A." and "N / A" are all the same word. A serial made only
// of punctuation ("-", "?") has an empty key and is refused for the same reason.

(function (root) {
  'use strict';

  function serialKey(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Keys, not spellings. Kept short on purpose: every entry is a word that is
  // never a real serial, so nothing a tech reads off equipment is refused.
  var PLACEHOLDERS = [
    'NA', 'NONE', 'NIL', 'NULL', 'UNKNOWN', 'UNK', 'TBD', 'TBA',
    'NOSERIAL', 'NOSERIALNUMBER', 'NOSN', 'NOSERIALNO', 'NONUMBER', 'NONUM',
    'NOTAG', 'NOLABEL', 'MISSING', 'ILLEGIBLE', 'NOTLEGIBLE', 'UNREADABLE',
    'BLANK', 'EMPTY', 'NOTAPPLICABLE',
  ];

  // Null when the serial is acceptable, otherwise the reason. A truly blank
  // field returns null: callers already handle that with their own prompt.
  function problem(serial) {
    var raw = String(serial == null ? '' : serial).trim();
    if (!raw) return null;
    var key = serialKey(raw);
    if (!key) return 'needs letters or numbers';
    if (PLACEHOLDERS.indexOf(key) !== -1) return 'placeholder';
    if (/^0+$/.test(key) || /^X+$/.test(key)) return 'placeholder';
    return null;
  }

  function isPlaceholder(serial) { return problem(serial) !== null; }

  var api = { problem: problem, isPlaceholder: isPlaceholder, serialKey: serialKey };
  root.LiaSerialCheck = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
