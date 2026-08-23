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
    nfc_tag_uid: i===7 ? '04:A1:B2:C3' : null, manufacturer:'MSA', model:'V-FIT',
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
out.forEach(l => console.log(l));
console.log('\npage errors:', errs.length ? errs : 'none');
await b.close();
const failed = out.filter(l => l.startsWith('FAIL')).length;
console.log(failed ? `RESULT: ${failed} failure(s)` : `RESULT: ${out.length} assertions passed`);
process.exit(failed || errs.length ? 1 : 0);
