// NFC wrapper. Hardware cannot be tested here; what is tested is that the app
// degrades correctly where NFC is absent, and parses a tag the way the rest of
// the system writes one. Run via `npm run test:field`.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'nfc.js'), 'utf8');

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('about:blank');
await p.addScriptTag({ content: src });

const out = await p.evaluate(async () => {
  const log = []; let fails = 0;
  const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
    log.push((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

  // Headless Chromium has no NDEFReader, which is the "no NFC" case exactly.
  ok('absent hardware reports unavailable', LiaNfc.isAvailable(), false);
  ok('and reading rejects rather than hanging',
     await LiaNfc.read().then(() => 'resolved', e => e.code), 'NFC_UNAVAILABLE');
  ok('with a message pointing at the alternatives',
     await LiaNfc.read().catch(e => /[Ss]can the barcode|installed app/.test(e.message)), true);
  ok('writing rejects the same way',
     await LiaNfc.write('H-1', 'https://x/?t=AB').then(() => 'resolved', e => e.code), 'NFC_UNAVAILABLE');
  ok('and writing nothing is refused outright',
     await LiaNfc.write('', '').then(() => 'resolved', e => e.code || 'err'), 'err');

  // Tag ids come off hardware in several shapes; all must resolve the same item.
  ok('tag ids normalize across formats',
     [LiaNfc.normalizeUid('04:A1:B2:C3'), LiaNfc.normalizeUid('04-a1-b2-c3'), LiaNfc.normalizeUid('04A1B2C3')],
     ['04A1B2C3', '04A1B2C3', '04A1B2C3']);

  // What certificate_url() writes onto a tag has to be readable back.
  const parsed = LiaNfc.parseRecords([
    { recordType: 'url', data: 'https://lia.mobileappdevelopmentgroup.com/fp/?t=B7K2M9QRXZ' },
    { recordType: 'text', data: 'H-4471-A' },
  ]);
  // Record order on a tag is not guaranteed, and the text record is the more
  // specific identifier — the URL only carries the certificate code.
  ok('a written tag reads back its serial, not the certificate code', parsed.serial, 'H-4471-A');
  ok('and its certificate url', /\/fp\/\?t=B7K2M9QRXZ$/.test(parsed.url), true);

  // A tag with only the URL still identifies the item, via the certificate code.
  const urlOnly = LiaNfc.parseRecords([{ recordType: 'url', data: 'https://x/fp/?t=CCDD11FFGG' }]);
  ok('a url-only tag still identifies the item', urlOnly.serial, 'CCDD11FFGG');

  ok('an empty tag yields nothing rather than throwing',
     LiaNfc.parseRecords([]), { serial: null, url: null, uid: null, ref: null, foreign: false });
  ok('and so does a malformed one', LiaNfc.parseRecords(null).serial, null);

  // ── Tags this app did not write ──────────────────────────────────────────
  // Most gear arrives already tagged by whoever supplied it. Two shapes turn
  // up, and both have to work.
  //
  // First: a link into somebody else's system. It carries no certificate code
  // and no serial — and the one thing it must NOT do is hand back something
  // that LOOKS like a serial, because whatever comes back gets written onto a
  // safety record as the item's serial number.
  const foreign = LiaNfc.parseRecords([
    { recordType: 'url', data: 'https://docs.google.com/spreadsheets/u/0/d/SHEET/htmlview' },
  ]);
  ok('a third-party link is not passed off as a serial', foreign.serial, null);
  ok('nor as a certificate code', foreign.ref, null);
  ok('but the link itself is kept — it is all the tag gave us',
     foreign.url, 'https://docs.google.com/spreadsheets/u/0/d/SHEET/htmlview');
  ok('and is flagged as somebody else’s', foreign.foreign, true);

  // Second: a plain serial written on the tag, no link at all. This is the
  // ordinary case and must keep resolving exactly as it did.
  const plain = LiaNfc.parseRecords([{ recordType: 'text', data: 'FP158354' }]);
  ok('a tag carrying only a serial still yields it', plain.serial, 'FP158354');
  ok('with nothing to fetch', [plain.url, plain.foreign], [null, false]);

  // A tag carrying BOTH: the serial wins as the identifier, and the link is
  // still recorded, because the record has to say which link was read.
  const both = LiaNfc.parseRecords([
    { recordType: 'url', data: 'https://acme.example/tag/FP158354' },
    { recordType: 'text', data: 'FP158354' },
  ]);
  ok('a tag with a serial AND a foreign link identifies by the serial', both.serial, 'FP158354');
  ok('and still records the link', both.url, 'https://acme.example/tag/FP158354');

  // Our own tags are not foreign, however they were read.
  ok('a certificate link is not flagged as foreign', parsed.foreign, false);

  // A url-only tag also hands back the certificate code on its own, so a caller
  // can look it up as a public_ref rather than guessing it is a serial.
  ok('and exposes it as a certificate ref', urlOnly.ref, 'CCDD11FFGG');

  // ── @exxili/capacitor-nfc ─────────────────────────────────────────────────
  // Its payloads are base64 of the RAW NDEF payload bytes on both platforms, so
  // the stub has to produce exactly that or the test proves nothing. A URI
  // record leads with its prefix code (0x04 = 'https://'); a text record with a
  // status byte and a language code.
  const b64 = bytes => btoa(String.fromCharCode.apply(null, bytes));
  const utf8 = str => Array.from(new TextEncoder().encode(str));
  const uriPayload = rest => b64([0x04].concat(utf8(rest)));
  const textPayload = str => b64([0x02].concat(utf8('en'), utf8(str)));

  ok('a real https URI payload decodes back to the url it was written from',
     LiaNfc.parseRecords(LiaNfc.fromExxili([{ records: [
       { type: 'U', payload: uriPayload('x/fp/?t=ABC1234567') },
     ] }])).url, 'https://x/fp/?t=ABC1234567');
  ok('and a real text payload sheds its status byte and language code',
     LiaNfc.parseRecords(LiaNfc.fromExxili([{ records: [
       { type: 'T', payload: textPayload('H-8888') },
     ] }])).serial, 'H-8888');
  // If a future plugin version stops encoding, the string must still be usable.
  ok('an unencoded payload is still read as-is',
     LiaNfc.parseRecords(LiaNfc.fromExxili([{ records: [
       { type: 'U', payload: 'https://x/fp/?t=ZZ11223344' },
     ] }])).ref, 'ZZ11223344');

  // The listener-based plugin adapted to the same shape.
  let scanStarted = false, cancelled = false;
  const listeners = {};
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { NFC: {
    startScan: async () => { scanStarted = true;
      setTimeout(() => listeners.nfcTag && listeners.nfcTag({
        messages: [{ records: [
          { type: 'U', payload: uriPayload('x/fp/?t=ABC1234567') },
          { type: 'T', payload: textPayload('H-8888') },
        ] }],
        tagInfo: { uid: '04:aa:bb:cc' },
      }), 10); },
    cancelScan: async () => { cancelled = true; },
    writeNDEF: async (o) => { window.__wrote = o; },
    addListener: (name, fn) => { listeners[name] = fn;
      return Promise.resolve({ remove: () => { delete listeners[name]; } }); },
  } } };
  ok('a listener-based plugin is detected', LiaNfc.isAvailable(), true);
  const lr = await LiaNfc.read();
  ok('its tag reads back the serial', lr.serial, 'H-8888');
  ok('and the certificate ref from the same tag', lr.ref, 'ABC1234567');
  ok('and the url, decoded rather than base64', lr.url, 'https://x/fp/?t=ABC1234567');
  ok('and the hardware id, normalized', lr.uid, '04AABBCC');
  ok('the scan was actually started', scanStarted, true);
  // A leaked listener would fire into a screen the tech has already left.
  ok('and torn down afterwards', Object.keys(listeners).length, 0);
  ok('the scan is cancelled too', cancelled, true);

  // A tag carrying no NDEF message at all: the plugin substitutes an 'ID'
  // record holding the hex uid. That identifies the item; it is not a serial.
  window.Capacitor.Plugins.NFC.startScan = async () => {
    setTimeout(() => listeners.nfcTag && listeners.nfcTag({
      messages: [{ records: [{ type: 'ID', payload: b64(utf8('04A1B2C3')) }] }],
    }), 10);
  };
  const idOnly = await LiaNfc.read();
  ok('a tag with no NDEF message still yields its hardware id', idOnly.uid, '04A1B2C3');
  ok('and does not pass that off as a serial', idOnly.serial, null);

  // Android turns on foreground dispatch when the activity resumes and rejects
  // startScan outright; treating that as fatal meant no tap ever arrived.
  window.Capacitor.getPlatform = () => 'android';
  window.Capacitor.Plugins.NFC.startScan = async () => {
    setTimeout(() => listeners.nfcTag && listeners.nfcTag({
      messages: [{ records: [{ type: 'T', payload: textPayload('H-7777') }] }],
      tagInfo: { uid: '04:11:22:33' },
    }), 10);
    throw new Error("Android NFC scanning does not require 'startScan' method.");
  };
  // Android implements no cancelScan either — a rejected promise, not a throw.
  window.Capacitor.Plugins.NFC.cancelScan = () =>
    Promise.reject(new Error('not implemented'));
  ok('a tap still lands on Android, where startScan rejects by design',
     await LiaNfc.read({ timeoutMs: 500 }).then(r => r.serial, e => 'rejected: ' + e.code), 'H-7777');
  window.Capacitor.Plugins.NFC.cancelScan = async () => { cancelled = true; };
  window.Capacitor.getPlatform = () => 'ios';

  await LiaNfc.write('H-8888', 'https://x/fp/?t=ABC1234567');
  ok('writing maps to the plugin record shape',
     window.__wrote.records.map(r => r.type), ['U', 'T']);

  // A tag that never arrives must not hang the UI forever.
  delete listeners.nfcTag;
  window.Capacitor.Plugins.NFC.startScan = async () => {};
  ok('a tag that never arrives times out',
     await LiaNfc.read({ timeoutMs: 60 }).then(() => 'resolved', e => e.code), 'NFC_TIMEOUT');

  // ── readStream: many tags, one arming gesture ─────────────────────────────
  let streamStarts = [], streamTags = [], streamErrs = [];
  window.Capacitor.getPlatform = () => 'ios';
  window.Capacitor.Plugins.NFC.startScan = async (o) => { streamStarts.push(o); };
  window.Capacitor.Plugins.NFC.cancelScan = async () => { cancelled = true; };
  const stream = LiaNfc.readStream({
    onTag: t => streamTags.push(t.serial), onError: e => streamErrs.push(e.code),
  });
  await new Promise(r => setTimeout(r, 20));
  ok('a stream asks the plugin for continuous reading', streamStarts, [{ continuous: true }]);
  ok('and tells the caller iOS may need re-arming', stream.needsArming, true);

  // Three tags, one session: the patched plugin restarts polling rather than
  // invalidating, so nothing re-arms in between.
  ['H-1','H-2','H-3'].forEach(sn => listeners.nfcTag({
    messages: [{ records: [{ type: 'T', payload: textPayload(sn) }] }] }));
  ok('every tap reaches the caller', streamTags, ['H-1','H-2','H-3']);
  ok('without re-opening the reader for each one', streamStarts.length, 1);

  // iOS ends a session on its own after about a minute; that is not something
  // the tech should have to act on.
  listeners.nfcError({ error: 'Session timeout' });
  await new Promise(r => setTimeout(r, 500));
  ok('a session that timed out is re-armed rather than reported', streamErrs, []);
  ok('which re-opens the reader', streamStarts.length, 2);

  // A reader failing for a real reason must not retry forever.
  for (let i = 0; i < 5; i++) { listeners.nfcError({ error: 'broken' }); await new Promise(r => setTimeout(r, 450)); }
  ok('but a reader that keeps failing is reported rather than retried forever',
     streamErrs.length > 0, true);

  stream.stop();
  ok('stopping tears the listeners down', Object.keys(listeners).length, 0);
  streamTags = [];
  ok('and no later tap reaches a stopped stream', streamTags, []);

  delete window.Capacitor;

  // A native plugin, once installed, must take precedence over Web NFC.
  window.Capacitor = { isNativePlatform: () => true, Plugins: { NfcPlugin: {
    read: async () => ({ id: '04:11:22:33', records: [{ recordType: 'text', data: 'H-9999' }] }),
    write: async () => ({ written: true }),
  } } };
  ok('a native plugin makes NFC available', LiaNfc.isAvailable(), true);
  const r = await LiaNfc.read();
  ok('and is used for reading', r.serial, 'H-9999');
  ok('with the hardware id normalized', r.uid, '04112233');
  ok('and for writing', await LiaNfc.write('H-9999', 'https://x/?t=AB').then(x => x.written), true);

  return { log, fails };
});
out.log.forEach(l => console.log(l));
console.log('\npage errors:', errs.length ? errs : 'none');
console.log(out.fails ? `RESULT: ${out.fails} failure(s)` : `RESULT: ${out.log.length} assertions passed`);
await b.close();
process.exit(out.fails || errs.length ? 1 : 0);
