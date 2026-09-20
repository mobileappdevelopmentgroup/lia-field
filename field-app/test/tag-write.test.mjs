// Writing our own tag onto a piece of equipment.
//
// The point of the feature is that a tech finds the right record holding ANY of
// five things: the serial, the label printed on the tag, the chip id, the
// certificate code, or the link. So most of these assertions are about that.
//
// The rest are about the two ways writing a tag can go wrong badly:
//   • the URL is built on the device, offline, and must match what the server
//     would have built — a tag written in a basement cannot say something
//     different from one written on wifi
//   • a write is queued ONLY if the tag physically took it, because nobody
//     re-checks a tag the system already believes is correct
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);

const ITEM = {
  asset_id: 'a1', serial_raw: 'TW-1', public_ref: 'B7K2M9QRXZ',
  kind: 'fall_protection', item_type: 'Body harness', updated_at: '2026-08-30T00:00:00Z',
};

// ── The URL ────────────────────────────────────────────────────────────────
// Must match fp_tag_url() in supabase/migrations/17_tag_write.sql character for character.
ok('the URL carries the certificate code and the serial',
   await p.evaluate(i => LiaTagWrite.urlFor(i), ITEM),
   'https://lia.mobileappdevelopmentgroup.com/fp/?t=B7K2M9QRXZ&s=TW-1');

// A '#' would truncate the query string at the fragment; a '/' would look like
// a path to anything parsing it loosely.
ok('a serial with punctuation is encoded the same way the server encodes it',
   await p.evaluate(() => LiaTagWrite.urlFor(
     { public_ref: 'REF1', serial_raw: 'A/B#1 C' })),
   'https://lia.mobileappdevelopmentgroup.com/fp/?t=REF1&s=A%2FB%231%20C');

// An item that has never reached the server has no durable identifier, so a tag
// written for it would point at nothing.
ok('an item with no certificate code gets no URL',
   await p.evaluate(() => LiaTagWrite.urlFor({ serial_raw: 'X' })), null);
ok('and the plan says so rather than offering to write',
   await p.evaluate(() => LiaTagWrite.plan({ serial_raw: 'X' }).ok), false);

// ── The plan ───────────────────────────────────────────────────────────────
ok('a fresh item is not a re-tag',
   await p.evaluate(i => LiaTagWrite.plan(i, 'FP158354').retag, ITEM), false);
ok('an item that already carries a tag is',
   await p.evaluate(i => LiaTagWrite.plan(
     Object.assign({}, i, { tag_label: 'FP000001' }), 'FP158354').retag, ITEM), true);
ok('and the plan says what is being replaced',
   await p.evaluate(i => LiaTagWrite.plan(
     Object.assign({}, i, { tag_label: 'FP000001' }), 'FP158354').prev_label, ITEM), 'FP000001');

// ── Writing ────────────────────────────────────────────────────────────────
// The physical write comes first. Queuing before it would leave the database
// claiming a tag says something it does not, and nobody re-checks a tag the
// system believes is already correct.
await p.evaluate(() => {
  window.__written = [];
  window.__nfcFails = false;
  window.LiaNfc.canWrite = () => true;
  window.LiaNfc.write = (serial, url) => {
    if (window.__nfcFails) return Promise.reject(new Error('Could not write to that tag.'));
    window.__written.push({ serial, url });
    return Promise.resolve({ written: true, uid: '04:11:22:33' });
  };
  try { localStorage.removeItem('lia-upload-queue'); } catch (_) {}
});

ok('a failed write queues nothing',
   await p.evaluate(async (i) => {
     window.__nfcFails = true;
     let msg = null;
     await LiaTagWrite.write(i, 'FP158354').catch(e => { msg = e.message; });
     return { msg, queued: LiaSync._readQueue().length };
   }, ITEM), { msg: 'Could not write to that tag.', queued: 0 });

const wrote = await p.evaluate(async (i) => {
  window.__nfcFails = false;
  const res = await LiaTagWrite.write(i, 'FP158354');
  const q = LiaSync._readQueue();
  return {
    toTag: window.__written[window.__written.length - 1],
    kind: q[0] && q[0].kind,
    payload: q[0] && q[0].payload,
    entryLabel: res.entry.tag_label,
  };
}, ITEM);

ok('the tag gets the serial as text and the certificate URL as a link',
   wrote.toTag,
   { serial: 'TW-1', url: 'https://lia.mobileappdevelopmentgroup.com/fp/?t=B7K2M9QRXZ&s=TW-1' });
ok('and a successful write is queued', wrote.kind, 'fp_tag_write');
ok('carrying the label, the chip id and the item',
   { label: wrote.payload.tag_label, uid: wrote.payload.nfc_tag_uid, asset: wrote.payload.asset_id },
   { label: 'FP158354', uid: '04:11:22:33', asset: 'a1' });
// The queue retries; the server keys on this so one tag is one write.
ok('with a client id, so a retry files one write and not five',
   await p.evaluate(() => !!LiaSync._readQueue()[0].payload.client_id), true);

// A tag write is a change to physical equipment. If the queue gave up on it,
// the item would resolve for nobody but the phone that wrote it.
ok('a tag write is not treated as optional traffic',
   await p.evaluate(() => LiaSync.pendingSummary().total), 1);

// ── The phone believes it immediately ──────────────────────────────────────
// Without this, a tech who tags a rack in a basement and taps one to check gets
// "not registered" back off his own phone, and re-writes a correct tag.
ok('the device cache learns the new tag at once',
   await p.evaluate(async () => {
     const hit = await LiaCache.findByLabel('FP158354');
     return hit ? { serial: hit.serial_raw, uid: hit.nfc_tag_uid } : null;
   }), { serial: 'TW-1', uid: '04:11:22:33' });

// ── Five ways in, one item ─────────────────────────────────────────────────
const found = await p.evaluate(async () => {
  const by = async v => { const h = await LiaCache.find(v); return h ? h.serial_raw : null; };
  return {
    serial: await by('TW-1'),
    label:  await by('FP158354'),
    // Punctuation off the hardware varies by platform.
    chip:   await by('04-11-22-33'),
    ref:    await by('B7K2M9QRXZ'),
    link:   await by('https://lia.mobileappdevelopmentgroup.com/fp/?t=B7K2M9QRXZ&s=TW-1'),
    // A link whose certificate code we do not know still carries the serial.
    linkBySerialOnly: await by('https://lia.mobileappdevelopmentgroup.com/fp/?t=NOPE00000&s=TW-1'),
    nonsense: await by('NOT-A-THING'),
  };
});
// Every one of them comes back with the SAME item — which is the whole point,
// so the expectation is the item's serial in all five cases, not the thing that
// was looked up.
ok('all five identifiers reach the same item, and nothing else does', found, {
  serial: 'TW-1', label: 'TW-1', chip: 'TW-1', ref: 'TW-1',
  link: 'TW-1', linkBySerialOnly: 'TW-1', nonsense: null,
});

// ── A label belongs to one item ────────────────────────────────────────────
ok('re-using a label from the same rack is caught on the device, with no signal',
   await p.evaluate(async () => {
     const hit = await LiaTagWrite.labelClash('FP158354', 'a2');
     return hit ? hit.serial_raw : null;
   }), 'TW-1');
ok('but re-writing the same item’s own label is not a clash',
   await p.evaluate(() => LiaTagWrite.labelClash('FP158354', 'a1')), null);

// ── Reading identifiers out of a link ──────────────────────────────────────
// `s` is an ordinary parameter name. Reading one off somebody else's system and
// looking it up as a serial is how a tap returns the WRONG item's record.
ok('a serial is only read out of our own links',
   await p.evaluate(() => ({
     ours:    LiaTagLink.serialFrom('https://lia.mobileappdevelopmentgroup.com/fp/?t=R&s=TW-1'),
     theirs:  LiaTagLink.serialFrom('https://acme.example/lookup?s=TW-1'),
     encoded: LiaTagLink.serialFrom('https://lia.mobileappdevelopmentgroup.com/fp/?t=R&s=A%2FB%231%20C'),
   })), { ours: 'TW-1', theirs: null, encoded: 'A/B#1 C' });

// ── The sheet ──────────────────────────────────────────────────────────────
await p.evaluate(i => { _fpItem = Object.assign({}, i); fpOpenWriteSheet(); }, ITEM);
await p.waitForTimeout(200);
ok('the sheet shows what is about to be written, before the phone touches a tag',
   await p.$eval('#tw-preview', e => /B7K2M9QRXZ&s=TW-1/.test(e.textContent)), true);

await p.fill('#tw-label', '');
await p.waitForTimeout(150);
// A tag with no label still works, but nobody can look it up by reading it.
ok('writing with no label is allowed, and the cost is stated',
   await p.$eval('#tw-warn', e => e.style.display !== 'none' && /nobody can look this item up/.test(e.textContent)), true);

// Held in the tech's hand: a second harness. FP158354 is already on the first.
await p.evaluate(() => {
  _fpItem = { asset_id: 'a2', serial_raw: 'TW-2', public_ref: 'C8L3N0RSYA' };
  fpOpenWriteSheet();
});
await p.fill('#tw-label', 'FP158354');
await p.waitForTimeout(300);
ok('a label already on another item is called out as an error',
   await p.evaluate(() => {
     const w = document.getElementById('tw-warn');
     return w.style.display !== 'none' && w.className.includes('err');
   }), true);

// A re-tag is not a mistake, but the old tag is still physically on the item.
await p.evaluate(i => {
  _fpItem = Object.assign({}, i, { tag_label: 'FP000001' });
  fpOpenWriteSheet();
}, ITEM);
await p.waitForTimeout(200);
ok('replacing a tag says so, and says to remove the old one',
   await p.$eval('#tw-desc', e => /take the old tag off/i.test(e.textContent)), true);

// Serials and labels come off customer equipment and go into innerHTML.
ok('a serial containing markup is escaped, not rendered',
   await p.evaluate(() => {
     _fpItem = { asset_id: 'x', public_ref: 'R', serial_raw: '<img src=x onerror=alert(1)>' };
     fpRenderWriteSheet();
     return { imgs: document.querySelectorAll('#tw-preview img').length,
              has: /<img src=x/.test(document.getElementById('tw-preview').textContent) };
   }), { imgs: 0, has: true });

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close();
process.exit(fails || errs.length ? 1 : 0);
