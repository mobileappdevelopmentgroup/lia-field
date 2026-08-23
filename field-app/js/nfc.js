// Lia Field — nfc.js
//
// Reading equipment tags, and writing a serial to a blank one.
//
// This is a thin, capability-detected wrapper. The actual native plugin is not
// installed yet (see docs/NFC-PLUGIN.md for the decision that is still open),
// so today only Web NFC — Chrome on Android — is live. Everywhere else the app
// must behave as though NFC simply does not exist: hidden affordance, scan and
// type still first-class, no dead button.
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
  const NDEF_TO_WEB = { U: 'url', T: 'text' };
  const WEB_TO_NDEF = { url: 'U', text: 'T' };

  function fromExxili(messages) {
    const records = [];
    (messages || []).forEach(function (m) {
      (m.records || []).forEach(function (r) {
        records.push({
          recordType: NDEF_TO_WEB[r.type] || r.type,
          data: r.payload,
        });
      });
    });
    return records;
  }

  // Listener API to a promise, with the listeners always torn down — a leaked
  // 'nfcTag' listener would fire into a screen the tech has already left.
  function exxiliRead(plugin, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var handles = [];
      function cleanup() {
        handles.forEach(function (h) { try { h && h.remove && h.remove(); } catch (_) {} });
        try { plugin.cancelScan(); } catch (_) {}
      }
      var timer = setTimeout(function () {
        if (done) return;
        done = true; cleanup();
        var e = new Error('No tag detected. Hold the phone against the tag.');
        e.code = 'NFC_TIMEOUT';
        reject(e);
      }, timeoutMs || 20000);

      Promise.resolve(plugin.addListener('nfcTag', function (data) {
        if (done) return;
        done = true; clearTimeout(timer); cleanup();
        var parsed = parseRecords(fromExxili(data && data.messages));
        resolve({
          serial: parsed.serial,
          url: parsed.url,
          uid: normalizeUid(data && data.tagInfo && data.tagInfo.uid),
        });
      })).then(function (h) { handles.push(h); });

      Promise.resolve(plugin.addListener('nfcError', function (err) {
        if (done) return;
        done = true; clearTimeout(timer); cleanup();
        var e = new Error((err && err.error) || 'That tag could not be read.');
        e.code = 'NFC_READ_ERROR';
        reject(e);
      })).then(function (h) { handles.push(h); });

      Promise.resolve(plugin.startScan()).catch(function (err) {
        if (done) return;
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
  function parseRecords(records) {
    const out = { serial: null, url: null, uid: null };
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
      } else if (!fromText) {
        fromText = value.trim();
      }
    });

    // The text record carries the equipment's own serial; the URL only carries
    // the certificate code. Record order on a tag is not guaranteed, so prefer
    // the more specific identifier rather than whichever was read first.
    out.serial = fromText || fromUrl;
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
          uid: normalizeUid(res && (res.id || res.uid)),
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
        resolve({ serial: parsed.serial, url: parsed.url, uid: normalizeUid(ev.serialNumber) });
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
      return Promise.resolve(exx.writeNDEF({
        records: records.map(function (r) {
          return { type: WEB_TO_NDEF[r.recordType] || r.recordType, payload: r.data };
        }),
      })).then(function () { return { written: true }; });
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
    write: write,
    normalizeUid: normalizeUid,
    parseRecords: parseRecords,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.LiaNfc;
})(typeof window !== 'undefined' ? window : globalThis);
