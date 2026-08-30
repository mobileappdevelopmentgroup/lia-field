// Device cache tests. Needs a real browser: IndexedDB has no Node equivalent,
// and the null-vs-undefined behaviour that bit us only shows up in a real
// implementation. Run with `npm run test:field`.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'device-cache.js'), 'utf8');
const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
// IndexedDB needs a real origin, not file://
await p.route('**/*', r => r.fulfill({ status:200, contentType:'text/html', body:'<!doctype html><title>t</title>' }));
await p.goto('https://lia.test/');
await p.addScriptTag({ content: src });

const out = await p.evaluate(async () => {
  const log = [];
  const ok = (label, got, want) => log.push(
    (JSON.stringify(got) === JSON.stringify(want) ? 'ok  ' : `FAIL ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)} — `) + label);

  // ── normalization must match the SQL exactly ──
  ok('serial normalizes like the database', LiaCache.serialKey('h-4471 a'), 'H4471A');
  ok('tag id normalizes across formats',
     [LiaCache.tagKey('04:A1:B2:C3'), LiaCache.tagKey('04-a1-b2-c3'), LiaCache.tagKey('04A1B2C3')],
     ['04A1B2C3','04A1B2C3','04A1B2C3']);

  // ── a fresh device must refuse to start work ──
  const before = await LiaCache.status();
  ok('a fresh device is not ready', before.ready, false);
  try { await LiaCache.requireFirstSync(); ok('fresh device refuses a job', 'no error', 'error'); }
  catch (e) { ok('fresh device refuses a job', e.code, 'NO_FIRST_SYNC'); }

  // ── stub Supabase ──
  const rows = [];
  for (let i = 0; i < 2500; i++) rows.push({
    asset_id:'a'+i, serial_raw:'H-'+i, serial_key:'H'+i, kind:'fall_protection',
    nfc_tag_uid: i===7 ? '04:A1:B2:C3' : null, public_ref:'REF'+i,
    manufacturer:'MSA', model:'V-FIT',
    item_type:'Harness', lot_number:'88-C', mfg_year:2024,
    last_inspected:'2025-04-12', next_due:'2026-04-12', rep_number:'BTV-4471',
    is_deleted:false, updated_at:new Date(Date.now()+i).toISOString(),
  });
  rows.push({ asset_id:'lad1', serial_raw:'H-7', serial_key:'H7', kind:'ladder',
    brand:'Werner', length:'28', last_inspected:'2025-03-01', is_deleted:false,
    updated_at:new Date(Date.now()+99999).toISOString() });

  let calls = 0;
  const sb = {
    rpc: async (fn, args) => {
      if (fn === 'account_snapshot_meta')
        return { data: { total: rows.length, changed: rows.length, next_since: '2026-08-23T00:00:00Z' }, error: null };
      calls++;
      let set = rows;
      if (args.p_after_updated) set = rows.filter(r =>
        r.updated_at > args.p_after_updated ||
        (r.updated_at === args.p_after_updated && r.asset_id > args.p_after_id));
      return { data: set.slice(0, args.p_limit), error: null };
    },
  };

  const prog = [];
  const res = await LiaCache.sync(sb, { onProgress: (d,t) => prog.push(d) });
  ok('every record landed', res.total, 2501);
  ok('a large sync came down in pages', calls > 1, true);
  ok('progress was reported', prog.length > 1, true);

  const after = await LiaCache.status();
  ok('the device is ready once synced', after.ready, true);
  ok('and knows how many it holds', after.count, 2501);

  // ── the three ways a tech identifies an item ──
  const byTag = await LiaCache.findByTag('04-A1-B2-C3');
  ok('an NFC tap resolves, whatever the tag format', byTag && byTag.serial_raw, 'H-7');
  // Punctuation and case must not matter: 'h 4 4' is H44, a real record.
  const loose = await LiaCache.findBySerial('h 4 4', 'fall_protection');
  ok('a loosely typed serial still resolves', loose && loose.serial_raw, 'H-44');
  const missing = await LiaCache.findBySerial('ZZ-9999', 'fall_protection');
  ok('a serial that is genuinely absent returns nothing', missing, null);
  const noTag = await LiaCache.findByTag('DEADBEEF');
  ok('an unknown tag returns nothing', noTag, null);
  // Most items have no tag; they must not all collide on an empty key.
  const emptyTag = await LiaCache.findByTag('');
  ok('an empty tag matches nothing', emptyTag, null);
  // A tag whose only record is the certificate URL identifies the item by the
  // public_ref in that URL — neither a tag id nor a serial the cache has seen.
  const byRef = await LiaCache.findByRef('REF44');
  ok('a certificate code resolves the item', byRef && byRef.serial_raw, 'H-44');
  ok('however it was punctuated coming off the tag',
     await LiaCache.findByRef('ref-44').then(r => r && r.serial_raw), 'H-44');
  ok('an unknown certificate code returns nothing', await LiaCache.findByRef('REFZZZZ'), null);
  ok('and an empty one matches nothing rather than everything',
     await LiaCache.findByRef(''), null);
  // find() is what the tap actually calls, and must reach all three.
  ok('find() reaches an item by its certificate code',
     await LiaCache.find('REF44', 'fall_protection').then(r => r && r.serial_raw), 'H-44');
  ok('and still prefers a real serial over one', 
     await LiaCache.find('H-44', 'fall_protection').then(r => r && r.serial_raw), 'H-44');
  ok('and still resolves a tag id', 
     await LiaCache.find('04-A1-B2-C3', 'fall_protection').then(r => r && r.serial_raw), 'H-7');

  const scanned = await LiaCache.findBySerial('H-1234', 'fall_protection');
  ok('a scanned serial comes back filled in', scanned && scanned.manufacturer, 'MSA');
  ok('with last year’s inspection date', scanned && scanned.last_inspected, '2025-04-12');

  // a ladder and an FP item may share a serial
  const asFp  = await LiaCache.findBySerial('H-7', 'fall_protection');
  const asLad = await LiaCache.findBySerial('H-7', 'ladder');
  ok('the same serial resolves per scope', [asFp.kind, asLad.kind], ['fall_protection','ladder']);
  ok('and the ladder carries ladder fields', asLad.brand, 'Werner');

  // ── delta, including a tombstone ──
  rows.length = 0;
  rows.push({ asset_id:'a5', serial_raw:'H-5', serial_key:'H5', kind:'fall_protection',
              manufacturer:'Petzl', model:'AVAO', is_deleted:false, updated_at:'2026-09-01T00:00:00Z' });
  rows.push({ asset_id:'a6', is_deleted:true, serial_raw:'H-6', serial_key:'H6',
              kind:'fall_protection', updated_at:'2026-09-01T00:00:01Z' });
  await LiaCache.sync(sb, {});
  const updated = await LiaCache.findBySerial('H-5', 'fall_protection');
  ok('a changed item is updated in place', updated && updated.manufacturer, 'Petzl');
  const deleted = await LiaCache.findBySerial('H-6', 'fall_protection');
  ok('a deleted item is removed, not left to shadow', deleted, null);

  await LiaCache.clear();
  ok('clearing resets the device', (await LiaCache.status()).ready, false);
  return log;
});
// ── v1 → v2 upgrade ─────────────────────────────────────────────────────────
// Every installed device is on v1. The v2 index is declared on public_ref
// directly rather than on a normalized copy precisely so that IndexedDB indexes
// the rows already sitting there — no backfill loop over 100k items, no forced
// re-sync. If that ever stops being true, a tech's first tap after an update
// silently finds nothing; so it is asserted rather than assumed. Its own origin,
// so it cannot disturb the database the tests above built.
const p2 = await b.newPage();
p2.on('pageerror', e => errs.push(e.message));
await p2.route('**/*', r => r.fulfill({ status:200, contentType:'text/html', body:'<!doctype html><title>t</title>' }));
await p2.goto('https://lia-upgrade.test/');

await p2.evaluate(() => new Promise((res, rej) => {
  // Exactly the shipped v1 schema.
  const rq = indexedDB.open('lia-field', 1);
  rq.onupgradeneeded = e => {
    const db = e.target.result;
    const s = db.createObjectStore('assets', { keyPath: 'asset_id' });
    s.createIndex('by_serial', 'serial_key', { unique: false });
    s.createIndex('by_tag', 'tag_key', { unique: false });
    s.createIndex('by_kind', 'kind', { unique: false });
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  rq.onsuccess = () => {
    const db = rq.result;
    const t = db.transaction(['assets', 'meta'], 'readwrite');
    t.objectStore('assets').put({ asset_id:'old1', serial_key:'H44', serial_raw:'H-44',
      kind:'fall_protection', tag_key:'04A1B2C3', public_ref:'REF44' });
    // A device that has already synced. The upgrade must not undo that: a tech
    // whose phone updates at a customer's site would otherwise be locked out of
    // starting a job by requireFirstSync.
    t.objectStore('meta').put({ key:'sync', since:'2026-08-01T00:00:00Z',
      at:'2026-08-01T00:00:00Z', count:1 });
    t.oncomplete = () => { db.close(); res(); };
    t.onerror = () => rej(t.error);
  };
  rq.onerror = () => rej(rq.error);
}));

await p2.addScriptTag({ content: src });
out.push(...await p2.evaluate(async () => {
  const log = [];
  const ok = (label, got, want) => log.push(
    (JSON.stringify(got) === JSON.stringify(want) ? 'ok  ' : `FAIL ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)} — `) + label);

  const byRef = await LiaCache.findByRef('REF44');
  const byTag = await LiaCache.findByTag('04:A1:B2:C3');
  const status = await LiaCache.status();
  const db = await new Promise(res => { const r = indexedDB.open('lia-field'); r.onsuccess = () => res(r.result); });
  const version = db.version;
  const indexes = Array.from(db.transaction('assets').objectStore('assets').indexNames).sort();
  const meta = await new Promise(res => {
    const rq = db.transaction('meta').objectStore('meta').get('sync');
    rq.onsuccess = () => res(rq.result);
  });
  db.close();

  ok('a v1 device is migrated to the current schema on open', version, 4);
  ok('and gains the certificate, link and tag-label indexes', indexes,
     ['by_kind','by_label','by_ref','by_serial','by_tag','by_url']);
  ok('a row written before the upgrade is found by its certificate code', byRef && byRef.serial_raw, 'H-44');
  ok('and is still found by its tag id', byTag && byTag.serial_raw, 'H-44');

  // Rows synced before the server had a tag_url to send index as empty, and the
  // incremental sync would never revisit them — so one full pull is needed.
  ok('the upgrade asks for one full re-sync', meta && meta.needsFullSync, true);
  // But NOT by clearing the mark: that is what requireFirstSync reads, and
  // blanking it strands a tech mid-shift with a catalogue he already has.
  ok('without discarding the sync it already had', meta && meta.since, '2026-08-01T00:00:00Z');
  ok('so a job can still be started offline', status.ready, true);

  // A link is a fourth way in, and must not be run through the other three:
  // tagKey() strips a URL down to whichever letters happen to be hex, which is
  // a key that can collide with a real tag uid — returning the WRONG item.
  const linked = await LiaCache.findByUrl('https://acme.example/tag/9');
  ok('an unknown link finds nothing rather than the wrong item', linked, null);
  ok('and a link never resolves as a hardware uid',
     await LiaCache.find('https://acme.example/EF/12'), null);
  return log;
}));


// ── v3 → v4: the tag label ──────────────────────────────────────────────────
// The upgrade real devices in the field will actually do. A v3 device has the
// link index but no label index, and its rows carry no tag_label_key — so the
// label lookup has to come back empty rather than wrong, and the device has to
// know it owes a full pull.
{
  const p3 = await b.newPage();
  p3.on('pageerror', e => errs.push(e.message));
  // IndexedDB needs a real origin, and its own one so this upgrade starts from
  // a clean v3 database rather than whatever the earlier pages left behind.
  await p3.route('**/*', r => r.fulfill({ status:200, contentType:'text/html', body:'<!doctype html><title>t</title>' }));
  await p3.goto('https://lia-v3.test/');
  await p3.evaluate(() => new Promise((res, rej) => {
    const rq = indexedDB.open('lia-field', 3);
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      const s = db.createObjectStore('assets', { keyPath: 'asset_id' });
      s.createIndex('by_serial', 'serial_key', { unique: false });
      s.createIndex('by_tag', 'tag_key', { unique: false });
      s.createIndex('by_kind', 'kind', { unique: false });
      s.createIndex('by_ref', 'public_ref', { unique: false });
      s.createIndex('by_url', 'tag_url_key', { unique: false });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    rq.onsuccess = () => {
      const db = rq.result;
      const t = db.transaction(['assets', 'meta'], 'readwrite');
      t.objectStore('assets').put({ asset_id: 'v3a', serial_key: 'H55', serial_raw: 'H-55',
        kind: 'fall_protection', public_ref: 'REF55', tag_key: '04FFEEDD' });
      t.objectStore('meta').put({ key: 'sync', since: '2026-08-20T00:00:00Z',
        at: '2026-08-20T00:00:00Z', count: 1 });
      t.oncomplete = () => { db.close(); res(); };
      t.onerror = () => rej(t.error);
    };
    rq.onerror = () => rej(rq.error);
  }));

  await p3.addScriptTag({ content: src });
  out.push(...await p3.evaluate(async () => {
    const log = [];
    const ok = (label, got, want) => log.push(
      (JSON.stringify(got) === JSON.stringify(want) ? 'ok  ' : `FAIL ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)} — `) + label);

    const byLabel = await LiaCache.findByLabel('FP158354');
    const bySerial = await LiaCache.findBySerial('H-55');
    const status = await LiaCache.status();
    const db = await new Promise(res => { const r = indexedDB.open('lia-field'); r.onsuccess = () => res(r.result); });
    const version = db.version;
    const indexes = Array.from(db.transaction('assets').objectStore('assets').indexNames).sort();
    db.close();

    ok('a v3 device gains the tag-label index', version, 4);
    ok('and keeps the ones it had', indexes,
       ['by_kind','by_label','by_ref','by_serial','by_tag','by_url']);
    // A miss, not a wrong answer. The rows predate the column.
    ok('a label lookup on un-backfilled rows finds nothing rather than the wrong item',
       byLabel, null);
    // And the tech is not stranded meanwhile.
    ok('the item is still found by everything it did have', bySerial && bySerial.serial_raw, 'H-55');
    ok('the device knows it owes a full pull', status.needsFullSync, true);
    ok('but can still start a job offline', status.ready, true);
    return log;
  }));
  await p3.close();
}

out.forEach(l => console.log(l));
console.log('\npage errors:', errs.length ? errs : 'none');
await b.close();
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(failed ? `RESULT: ${failed} failure(s)` : `RESULT: ${out.length} assertions passed`);
process.exit(failed || errs.length ? 1 : 0);
