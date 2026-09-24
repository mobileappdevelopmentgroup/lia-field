// Lia Field — nfc.js
//
// Reading equipment tags, and writing a serial to a blank one.
//
// This is a thin, capability-detected wrapper around @exxili/capacitor-nfc
// (see docs/NFC-PLUGIN.md), with Web NFC as the fallback. Where neither is
// present the app must behave as though NFC simply does not exist: hidden
// affordance, scan and type still first-class, no dead button.
//
// The platform constraint worth knowing before designing around this: iOS Core
// NFC can only read or write from a foreground session that shows Apple's own
// system sheet. There is no silent read and no background write. The UX has to
// be "tap the button, then hold the phone to the tag" — never an inline field
// that fills itself.
//
// Part of the field app. Classic script — see the note in storage.js.

(function (root) {
  'use strict';

  // Populated by the native plugin when one is installed. Until then this stays
  // null and the Web NFC path is the only one.
  //
  // Two shapes are accepted. `NfcPlugin`/`Nfc` with read()/write() is the simple
  // promise API a hand-written in-repo plugin would expose. `NFC` is
  // @exxili/capacitor-nfc, which is listener-based — startScan then an 'nfcTag'
  // event — and is adapted below. Keeping both means the plugin choice can
  // change without touching anything that calls LiaNfc.
  function nativePlugin() {
    const cap = root.Capacitor;
    if (!cap || !cap.Plugins) return null;
    return cap.Plugins.NfcPlugin || cap.Plugins.Nfc || null;
  }

  function exxiliPlugin() {
    const cap = root.Capacitor;
    if (!cap || !cap.Plugins) return null;
    const p = cap.Plugins.NFC;
    return p && typeof p.startScan === 'function' ? p : null;
  }

  // Its records carry {type, payload} with RAW NDEF type codes — 'U' for a URI
  // record and 'T' for text — where Web NFC uses the friendlier 'url'/'text'.
  // Translate both ways so the rest of the app only ever sees one vocabulary.
  //
  // Its payloads are worse than that: `payload` is base64 of the RAW NDEF
  // payload bytes, on both platforms (NFCPlugin.swift, NFCPlugin.kt
  // ndefMessageToJS). Raw means a URI record still carries its one-byte prefix
  // code and a text record its status byte and language code — so a tag written
  // by this very app came back as base64 that matched nothing, and the tech was
  // shown a blank form for an item already in the catalogue.
  const NDEF_TO_WEB = { U: 'url', T: 'text', ID: 'id' };
  const WEB_TO_NDEF = { url: 'U', text: 'T' };

  // NFC Forum RTD-URI abbreviation table. Index 0x04 — 'https://' — is what
  // every tag this app writes uses; the rest are here so a tag written by some
  // other tool still reads.
  const URI_PREFIX = [
    '', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:',
    'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://', 'sftp://', 'smb://',
    'nfs://', 'ftp://', 'dav://', 'news:', 'telnet://', 'imap:', 'rtsp://',
    'urn:', 'pop:', 'sip:', 'sips:', 'tftp:', 'btspp://', 'btl2cap://',
    'btgoep://', 'tcpobex://', 'irdaobex://', 'file://', 'urn:epc:id:',
    'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:', 'urn:nfc:',
  ];

  // Null rather than a throw when the string is not base64 at all: the plugin is
  // 0.0.x with one maintainer, and if a future version starts sending plain text
  // the caller falls back to using it as-is rather than decoding it to noise.
  function b64Bytes(str) {
    if (typeof str !== 'string' || !str.length) return null;
    if (str.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(str)) return null;
    try {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) { return null; }
  }

  function utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (_) { return ''; }
  }

  // Raw NDEF payload bytes to the string the record means.
  function fromNdefPayload(ndefType, bytes) {
    if (!bytes || !bytes.length) return '';
    if (ndefType === 'U') {
      const prefix = URI_PREFIX[bytes[0]] || '';
      return prefix + utf8(bytes.subarray(1));
    }
    if (ndefType === 'T') {
      // Status byte: bit 7 is the encoding, bits 0-5 the language-code length.
      const status = bytes[0];
      const langLen = status & 0x3f;
      const enc = (status & 0x80) ? 'utf-16' : 'utf-8';
      try { return new TextDecoder(enc).decode(bytes.subarray(1 + langLen)); }
      catch (_) { return ''; }
    }
    // 'ID' is the plugin's own fallback record — the hardware uid as hex text.
    return utf8(bytes);
  }

  function fromExxili(messages) {
    const records = [];
    (messages || []).forEach(function (m) {
      (m.records || []).forEach(function (r) {
        const bytes = b64Bytes(r.payload);
        let value = bytes ? fromNdefPayload(r.type, bytes) : r.payload;
        // A URI record that did not decode to something with a scheme means the
        // guess was wrong somewhere; the undecoded string is the better bet.
        if (r.type === 'U' && bytes && !/^[a-z][a-z0-9+.-]*:/i.test(value)
            && /^[a-z][a-z0-9+.-]*:/i.test(String(r.payload))) {
          value = r.payload;
        }
        records.push({
          recordType: NDEF_TO_WEB[r.type] || r.type,
          data: value,
        });
      });
    });
    return records;
  }

  // The plugin announces a change of iOS reader mode by firing 'nfcTag' with no
  // messages and {fallback: true} where the tag info goes. That is not a tag.
  // Taken as one, read() resolved with nothing and removed its listener, and
  // the tag the tech then held up was read by a session nobody was listening
  // to: Apple's sheet said "Found 1 NDEF message" and the app did nothing.
  function isModeNotice(data) {
    return !!(data && data.tagInfo && data.tagInfo.fallback === true
              && !(data.messages && data.messages.length));
  }

  // Where iOS reading starts. The plugin's default polls FeliCa too, which
  // needs system codes in Info.plist that this app does not declare, so every
  // session failed with a missing-entitlement error and fell back to this mode
  // anyway — a failed session and a notice, each read. Our tags are NTAG
  // (ISO 14443), which this mode covers. Android ignores it.
  const IOS_READ_MODE = 'compat';

  // Listener API to a promise, with the listeners always torn down — a leaked
  // 'nfcTag' listener would fire into a screen the tech has already left.
  function exxiliRead(plugin, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var handles = [];
      function cleanup() {
        handles.forEach(function (h) { try { h && h.remove && h.remove(); } catch (_) {} });
        // Android implements no cancelScan — Capacitor answers with a REJECTED
        // promise, which a try/catch does not see. Left bare it was an unhandled
        // rejection on every read.
        try { Promise.resolve(plugin.cancelScan()).catch(function () {}); } catch (_) {}
      }
      var timer = setTimeout(function () {
        if (done) return;
        done = true; cleanup();
        var e = new Error('No tag detected. Hold the phone against the tag.');
        e.code = 'NFC_TIMEOUT';
        reject(e);
      }, timeoutMs || 20000);

      Promise.resolve(plugin.addListener('nfcTag', function (data) {
        if (done || isModeNotice(data)) return;
        done = true; clearTimeout(timer); cleanup();
        var parsed = parseRecords(fromExxili(data && data.messages));
        resolve({
          serial: parsed.serial,
          url: parsed.url,
          ref: parsed.ref,
          foreign: parsed.foreign,
          uid: normalizeUid(data && data.tagInfo && data.tagInfo.uid) || parsed.uid,
        });
      })).then(function (h) { handles.push(h); });

      Promise.resolve(plugin.addListener('nfcError', function (err) {
        if (done) return;
        done = true; clearTimeout(timer); cleanup();
        var e = new Error((err && err.error) || 'That tag could not be read.');
        e.code = 'NFC_READ_ERROR';
        reject(e);
      })).then(function (h) { handles.push(h); });

      // On Android there is nothing to start: the plugin turns on foreground
      // dispatch whenever the activity resumes, and startScan() rejects outright
      // with "Android NFC scanning does not require 'startScan' method."
      // Treating that as a failure tore down the listeners we had just installed,
      // so no tap on Android ever reached the app.
      Promise.resolve(plugin.startScan({ mode: IOS_READ_MODE })).catch(function (err) {
        if (done || isAndroid()) return;
        done = true; clearTimeout(timer); cleanup();
        var e = new Error((err && err.message) || 'Could not start the tag reader.');
        e.code = 'NFC_START_FAILED';
        reject(e);
      });
    });
  }

  function isNative() {
    return !!(root.Capacitor && root.Capacitor.isNativePlatform && root.Capacitor.isNativePlatform());
  }

  function isAndroid() {
    const cap = root.Capacitor;
    return !!(cap && cap.getPlatform && cap.getPlatform() === 'android');
  }

  // Never assume: a device can have no NFC hardware, or have it switched off in
  // settings, and both must degrade to "not available" rather than to an error.
  function isAvailable() {
    if (nativePlugin() || exxiliPlugin()) return true;
    if ('NDEFReader' in root) return true;
    return false;
  }

  function canWrite() {
    if (nativePlugin() || exxiliPlugin()) return true;
    // Web NFC can write, but only on Chrome for Android.
    return 'NDEFReader' in root;
  }

  function unavailable() {
    const e = new Error(isNative()
      ? 'This device cannot read NFC tags. Scan the barcode or type the serial instead.'
      : 'Tag reading needs the installed app. Scan the barcode or type the serial instead.');
    e.code = 'NFC_UNAVAILABLE';
    return e;
  }

  // Normalized the same way the cache and the database do, so a tag read one way
  // matches a tag written another.
  function normalizeUid(uid) {
    return String(uid == null ? '' : uid).toUpperCase().replace(/[^A-F0-9]/g, '');
  }

  // Tags carry two things: the certificate URL, which is what a customer's phone
  // opens when they tap it, and a text record with the serial for our own app.
  //
  // A tag the customer already had carries neither. Its link points into
  // somebody else's system, so it yields no ref and no serial — and the one
  // thing it must NOT do is hand back something that looks like a serial. A URL
  // stuffed into the serial field, or a hardware uid used as one, writes a wrong
  // identifier onto a safety record. `foreign` is how a caller tells the two
  // apart without re-parsing the URL itself.
  function parseRecords(records) {
    const out = { serial: null, url: null, uid: null, ref: null, foreign: false };
    let fromText = null, fromUrl = null;

    (records || []).forEach(function (r) {
      const type = r.recordType || r.type;
      const value = typeof r.data === 'string' ? r.data : decodeData(r);
      if (!value) return;
      if (type === 'url' || /^https?:\/\//i.test(value)) {
        out.url = value;
        // ?t=<public_ref> is what certificate_url() writes.
        const m = value.match(/[?&]t=([A-Z0-9]+)/i);
        if (m && !fromUrl) fromUrl = m[1];
      } else if (type === 'id') {
        // The plugin's stand-in for a tag with no NDEF message at all: the
        // hardware uid as hex. It identifies the item; it is not a serial.
        if (!out.uid) out.uid = normalizeUid(value);
      } else if (!fromText) {
        fromText = value.trim();
      }
    });

    // The text record carries the equipment's own serial; the URL only carries
    // the certificate code. Record order on a tag is not guaranteed, so prefer
    // the more specific identifier rather than whichever was read first.
    out.ref = fromUrl;
    out.serial = fromText || fromUrl;
    // A link that yielded no certificate code belongs to somebody else's system.
    // It is still the best handle we have on the item, but it is not an
    // identifier this account's catalogue has ever seen.
    out.foreign = !!out.url && !fromUrl;
    return out;
  }

  function decodeData(record) {
    try {
      if (!record.data) return '';
      if (typeof TextDecoder === 'undefined') return '';
      return new TextDecoder(record.encoding || 'utf-8').decode(record.data);
    } catch (_) { return ''; }
  }

  // Resolves with whatever identifies the item: the serial from the tag if it
  // carries one, otherwise the hardware uid, which the catalogue also indexes.
  function read(opts) {
    opts = opts || {};
    const plugin = nativePlugin();
    if (plugin && plugin.read) {
      return plugin.read().then(function (res) {
        const parsed = parseRecords(res && res.records);
        return {
          serial: parsed.serial,
          url: parsed.url,
          ref: parsed.ref,
          foreign: parsed.foreign,
          uid: normalizeUid(res && (res.id || res.uid)) || parsed.uid,
        };
      });
    }

    const exx = exxiliPlugin();
    if (exx) return exxiliRead(exx, opts.timeoutMs);

    if (!('NDEFReader' in root)) return Promise.reject(unavailable());

    return new Promise(function (resolve, reject) {
      let reader;
      try { reader = new root.NDEFReader(); }
      catch (_) { reject(unavailable()); return; }

      const ctrl = new AbortController();
      // Without a timeout the reader stays open indefinitely and the UI has no
      // way to tell the tech nothing happened.
      const timer = setTimeout(function () {
        ctrl.abort();
        const e = new Error('No tag detected. Hold the phone against the tag.');
        e.code = 'NFC_TIMEOUT';
        reject(e);
      }, opts.timeoutMs || 20000);

      reader.addEventListener('reading', function (ev) {
        clearTimeout(timer);
        ctrl.abort();
        const parsed = parseRecords(ev.message && ev.message.records);
        resolve({
          serial: parsed.serial,
          url: parsed.url,
          ref: parsed.ref,
          foreign: parsed.foreign,
          uid: normalizeUid(ev.serialNumber) || parsed.uid,
        });
      });

      reader.addEventListener('readingerror', function () {
        clearTimeout(timer);
        ctrl.abort();
        const e = new Error('That tag could not be read.');
        e.code = 'NFC_READ_ERROR';
        reject(e);
      });

      reader.scan({ signal: ctrl.signal }).catch(function (err) {
        clearTimeout(timer);
        // A refused permission is a decision, not a fault — say so plainly.
        const e = new Error(err && err.name === 'NotAllowedError'
          ? 'NFC permission was declined. Scan the barcode or type the serial instead.'
          : 'Could not start the tag reader.');
        e.code = 'NFC_START_FAILED';
        reject(e);
      });
    });
  }

  // ── Continuous read ────────────────────────────────────────────────────────
  // read() above is one item and one answer. This one stays armed and calls
  // back per tag until it is stopped — for tapping through a rack of items that
  // have already been inspected by hand.
  //
  // What "stays armed" costs differs by platform, and the caller does not have
  // to care:
  //
  //   Android  foreground dispatch is already on whenever the activity is
  //            resumed, so the listener alone is enough: taps arrive silently
  //            and indefinitely.
  //   iOS      Core NFC ends the session after every tag, so it is re-armed —
  //            which re-shows Apple's sheet. Until the plugin is patched to
  //            restartPolling() instead of invalidating, that is one sheet per
  //            tag. Nothing here changes when it is.
  //   Web NFC  one scan() keeps emitting 'reading' per tap.
  //
  // Neither platform reads with the screen off or the app backgrounded, so a
  // stream is only alive while the tech is looking at it.
  function readStream(opts) {
    opts = opts || {};
    const onTag = opts.onTag || function () {};
    const onError = opts.onError || function () {};

    const exx = exxiliPlugin();
    if (exx) return exxiliStream(exx, onTag, onError);

    const plugin = nativePlugin();
    if (plugin && plugin.read) return pollingStream(plugin, onTag, onError);

    if ('NDEFReader' in root) return webStream(onTag, onError);

    onError(unavailable());
    return { stop: function () {}, arm: function () {}, needsArming: false };
  }

  function streamError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // iOS ends a reader session on its own after about a minute. Re-arming on the
  // session's own error keeps a run alive across that without the tech noticing,
  // but a reader that is failing for a real reason must not be retried forever —
  // so it is capped, and the count resets on every tag that does arrive.
  const STREAM_REARM_LIMIT = 3;

  function exxiliStream(plugin, onTag, onError) {
    let stopped = false;
    let rearms = 0;
    const handles = [];

    function arm() {
      if (stopped) return;
      rearms = 0;
      // continuous: the patched plugin calls restartPolling() rather than
      // invalidating after each tag, so one sheet covers a whole rack. An
      // unpatched build ignores the flag and closes after one — see
      // scripts/patch-nfc-plugin.mjs.
      Promise.resolve(plugin.startScan({ continuous: true, mode: IOS_READ_MODE })).catch(function (err) {
        // Android rejects this by design — there is nothing to start there.
        if (stopped || isAndroid()) return;
        onError(streamError((err && err.message) || 'Could not start the tag reader.',
                            'NFC_START_FAILED'));
      });
    }

    Promise.resolve(plugin.addListener('nfcTag', function (data) {
      if (stopped || isModeNotice(data)) return;
      rearms = 0;
      const parsed = parseRecords(fromExxili(data && data.messages));
      onTag({
        serial: parsed.serial,
        url: parsed.url,
        ref: parsed.ref,
        foreign: parsed.foreign,
        uid: normalizeUid(data && data.tagInfo && data.tagInfo.uid) || parsed.uid,
      });
    })).then(function (h) { if (stopped) { try { h.remove(); } catch (_) {} } else handles.push(h); });

    Promise.resolve(plugin.addListener('nfcError', function (err) {
      if (stopped) return;
      const e = streamError((err && err.error) || 'That tag could not be read.', 'NFC_READ_ERROR');
      // A session that timed out is not a fault the tech should have to act on.
      if (!isAndroid() && rearms < STREAM_REARM_LIMIT) {
        rearms++;
        setTimeout(function () {
          if (stopped) return;
          Promise.resolve(plugin.startScan({ continuous: true, mode: IOS_READ_MODE })).catch(function () {});
        }, 400);
        return;
      }
      onError(e);
    })).then(function (h) { if (stopped) { try { h.remove(); } catch (_) {} } else handles.push(h); });

    arm();

    return {
      stop: function () {
        stopped = true;
        handles.forEach(function (h) { try { h && h.remove && h.remove(); } catch (_) {} });
        handles.length = 0;
        try { Promise.resolve(plugin.cancelScan()).catch(function () {}); } catch (_) {}
      },
      arm: arm,
      // iOS puts a sheet in front of the tech that he can dismiss, which kills
      // the stream silently. The UI needs to offer him a way back.
      needsArming: !isAndroid(),
    };
  }

  // A hand-written plugin exposing only a one-shot read(): loop it.
  function pollingStream(plugin, onTag, onError) {
    let stopped = false;
    function loop() {
      if (stopped) return;
      read().then(function (res) {
        if (stopped) return;
        onTag(res);
        loop();
      }).catch(function (err) {
        if (stopped) return;
        if (err && err.code === 'NFC_TIMEOUT') { loop(); return; }
        onError(err);
      });
    }
    loop();
    return { stop: function () { stopped = true; }, arm: loop, needsArming: false };
  }

  function webStream(onTag, onError) {
    let reader;
    try { reader = new root.NDEFReader(); }
    catch (_) { onError(unavailable()); return { stop: function () {}, arm: function () {}, needsArming: false }; }

    const ctrl = new AbortController();

    reader.addEventListener('reading', function (ev) {
      const parsed = parseRecords(ev.message && ev.message.records);
      onTag({
        serial: parsed.serial,
        url: parsed.url,
        ref: parsed.ref,
        foreign: parsed.foreign,
        uid: normalizeUid(ev.serialNumber) || parsed.uid,
      });
    });
    reader.addEventListener('readingerror', function () {
      onError(streamError('That tag could not be read.', 'NFC_READ_ERROR'));
    });
    reader.scan({ signal: ctrl.signal }).catch(function (err) {
      onError(streamError(err && err.name === 'NotAllowedError'
        ? 'NFC permission was declined.'
        : 'Could not start the tag reader.', 'NFC_START_FAILED'));
    });

    return { stop: function () { ctrl.abort(); }, arm: function () {}, needsArming: false };
  }

  // The inverse of fromNdefPayload: the raw payload bytes, as a plain array.
  //
  // The plugin's native writeNDEF takes bytes and nothing else. Its own JS
  // wrapper would do this encoding, but this file talks to Capacitor.Plugins.NFC
  // directly, and handed a string the native side dropped it — iOS skipped
  // every record and wrote an empty message, Android failed the record.
  function utf8Array(str) {
    return Array.from(new TextEncoder().encode(String(str)));
  }

  function toNdefPayload(ndefType, value) {
    if (ndefType === 'U') {
      // The longest matching abbreviation, so https:// costs one byte, not eight
      // — room that matters on a 144-byte NTAG213.
      const lower = String(value).toLowerCase();
      let code = 0;
      for (let i = 1; i < URI_PREFIX.length; i++) {
        if (lower.startsWith(URI_PREFIX[i]) && URI_PREFIX[i].length > URI_PREFIX[code].length) code = i;
      }
      return [code].concat(utf8Array(String(value).slice(URI_PREFIX[code].length)));
    }
    if (ndefType === 'T') {
      // Status byte: UTF-8, two-letter language code, then 'en'.
      return [0x02].concat(utf8Array('en'), utf8Array(value));
    }
    return utf8Array(value);
  }

  // Resolves only when the tag has actually been written. The native
  // writeNDEF resolves the moment it is called — before any tag is near the
  // phone — and the real outcome arrives later as an 'nfcWriteSuccess' or
  // 'nfcError' event. Taking the call's own resolution as success is what let
  // LiaTagWrite record tags that were never written.
  function exxiliWrite(plugin, records) {
    // iOS: the plugin gives JS no way to close its write sheet, and says nothing
    // when the tech dismisses it. Apple closes it after 60 seconds and that IS
    // reported, so wait past it — giving up while the sheet is still up could
    // report a failure for a tag that then gets written.
    const timeoutMs = isAndroid() ? 30000 : 65000;
    return new Promise(function (resolve, reject) {
      let done = false;
      let handles = [];
      function removeAll() {
        handles.forEach(function (h) { try { h && h.remove && h.remove(); } catch (_) {} });
        handles = [];
      }
      function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        removeAll();
        if (!err) { resolve({ written: true }); return; }
        // Left armed, Android treats the next tag it sees — a READ, on another
        // screen — as the write it was waiting for.
        if (isAndroid() && plugin.cancelWriteAndroid) {
          try { Promise.resolve(plugin.cancelWriteAndroid()).catch(function () {}); } catch (_) {}
        }
        reject(err);
      }
      const timer = setTimeout(function () {
        const e = new Error('No tag detected. Hold the phone against the tag.');
        e.code = 'NFC_TIMEOUT';
        finish(e);
      }, timeoutMs);

      Promise.all([
        plugin.addListener('nfcWriteSuccess', function () { finish(null); }),
        plugin.addListener('nfcError', function (err) {
          const e = new Error((err && err.error) || 'Could not write to that tag. It may be locked or too small.');
          e.code = 'NFC_WRITE_FAILED';
          finish(e);
        }),
      ]).then(function (hs) {
        handles = hs;
        if (done) { removeAll(); return; }
        // Listeners first: a tag already on the phone can answer immediately.
        return plugin.writeNDEF({ records: records });
      }).catch(function (err) {
        const e = new Error((err && err.message) || 'Could not start writing the tag.');
        e.code = 'NFC_WRITE_FAILED';
        finish(e);
      });
    });
  }

  // Writes the certificate URL plus the serial. NTAG213 holds 144 bytes, so the
  // URL alone fits comfortably and URL + a long serial still does; anything
  // larger belongs on a bigger tag.
  function write(serial, certificateUrl) {
    const records = [];
    if (certificateUrl) records.push({ recordType: 'url', data: certificateUrl });
    if (serial) records.push({ recordType: 'text', data: String(serial) });
    if (!records.length) return Promise.reject(new Error('Nothing to write to the tag.'));

    const plugin = nativePlugin();
    if (plugin && plugin.write) return plugin.write({ records: records });

    const exx = exxiliPlugin();
    if (exx) {
      return exxiliWrite(exx, records.map(function (r) {
        const type = WEB_TO_NDEF[r.recordType] || r.recordType;
        return { type: type, payload: toNdefPayload(type, r.data) };
      }));
    }

    if (!('NDEFReader' in root)) return Promise.reject(unavailable());

    return new Promise(function (resolve, reject) {
      let writer;
      try { writer = new root.NDEFReader(); }
      catch (_) { reject(unavailable()); return; }

      const ctrl = new AbortController();
      const timer = setTimeout(function () {
        ctrl.abort();
        const e = new Error('No tag detected. Hold the phone against the tag.');
        e.code = 'NFC_TIMEOUT';
        reject(e);
      }, 20000);

      writer.write({ records: records }, { signal: ctrl.signal }).then(function () {
        clearTimeout(timer);
        resolve({ written: true });
      }).catch(function (err) {
        clearTimeout(timer);
        const e = new Error(err && err.name === 'NotAllowedError'
          ? 'NFC permission was declined.'
          : 'Could not write to that tag. It may be locked or too small.');
        e.code = 'NFC_WRITE_FAILED';
        reject(e);
      });
    });
  }

  root.LiaNfc = {
    isAvailable: isAvailable,
    canWrite: canWrite,
    isNative: isNative,
    read: read,
    readStream: readStream,
    write: write,
    normalizeUid: normalizeUid,
    parseRecords: parseRecords,
    fromExxili: fromExxili,
    isAndroid: isAndroid,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.LiaNfc;
})(typeof window !== 'undefined' ? window : globalThis);
