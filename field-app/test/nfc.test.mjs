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
    { recordType: 'url', data: 'https://d1uwg2boqwq3l6.cloudfront.net/fp/?t=B7K2M9QRXZ' },
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
     LiaNfc.parseRecords([]), { serial: null, url: null, uid: null });
  ok('and so does a malformed one', LiaNfc.parseRecords(null).serial, null);

  // The listener-based plugin (@exxili/capacitor-nfc) adapted to the same shape.
  let scanStarted = false, cancelled = false;
  const listeners = {};
  window.Capacitor = { isNativePlatform: () => true, Plugins: { NFC: {
    startScan: async () => { scanStarted = true;
      setTimeout(() => listeners.nfcTag && listeners.nfcTag({
        messages: [{ records: [
          { type: 'U', payload: 'https://x/fp/?t=ABC1234567' },
          { type: 'T', payload: 'H-8888' },
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
  ok('and the hardware id, normalized', lr.uid, '04AABBCC');
  ok('the scan was actually started', scanStarted, true);
  // A leaked listener would fire into a screen the tech has already left.
  ok('and torn down afterwards', Object.keys(listeners).length, 0);
  ok('the scan is cancelled too', cancelled, true);

  await LiaNfc.write('H-8888', 'https://x/fp/?t=ABC1234567');
  ok('writing maps to the plugin record shape',
     window.__wrote.records.map(r => r.type), ['U', 'T']);

  // A tag that never arrives must not hang the UI forever.
  listeners.nfcTag = null;
  window.Capacitor.Plugins.NFC.startScan = async () => {};
  ok('a tag that never arrives times out',
     await LiaNfc.read({ timeoutMs: 60 }).then(() => 'resolved', e => e.code), 'NFC_TIMEOUT');
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
