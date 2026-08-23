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
  function nativePlugin() {
    const cap = root.Capacitor;
    if (!cap || !cap.Plugins) return null;
    return cap.Plugins.NfcPlugin || cap.Plugins.Nfc || null;
  }

  function isNative() {
    return !!(root.Capacitor && root.Capacitor.isNativePlatform && root.Capacitor.isNativePlatform());
  }

  // Never assume: a device can have no NFC hardware, or have it switched off in
  // settings, and both must degrade to "not available" rather than to an error.
  function isAvailable() {
    if (nativePlugin()) return true;
    if ('NDEFReader' in root) return true;
    return false;
  }

  function canWrite() {
    if (nativePlugin()) return true;
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
