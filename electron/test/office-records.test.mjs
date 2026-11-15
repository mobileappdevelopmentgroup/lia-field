// Saving an office import's ladders (electron/office-records.cjs). From
// 2026-08-22 no ladder imported through Lia Office reached the database, and
// nobody saw it because the result was thrown away. These assert that every
// outcome is reported, that one bad ladder costs one record, that failures are
// kept and retried, and that a retry never lands in the wrong account.
// Pure Node, no Electron: `node electron/test/office-records.test.mjs`.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const R = require('../office-records.cjs');

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lia-outbox-'));
const box = path.join(dir, 'pending-inspections.json');

// A fake server. `refuse(serial)` returns an error message or null; `down`
// makes every call fail as a network error would.
function server({ refuse = () => null, down = false } = {}) {
  const saved = [];
  const calls = [];
  return {
    saved, calls,
    async rpc(name, { p }) {
      calls.push(name);
      if (down) throw new Error('fetch failed');
      const recs = name === 'record_inspections' ? p : [p];
      const bad = recs.map(r => refuse(r.serial_num)).find(Boolean);
      if (bad) return { data: null, error: { message: bad } };
      saved.push(...recs);
      return { data: recs.length, error: null };
    },
  };
}

const rows = [
  { serial: '1509436', brand: 'LG', type: 'Ext', length: '28' },
  { serial: ' 1669421 ', brand: 'LG', type: 'Ext', length: '28' },
  { serial: '' },
];

// ── toRecords ────────────────────────────────────────────────────────────────
const recs = R.toRecords(rows, '98378', 'Nate Dobbs', 'office', '2026-11-13');
ok('blank serials are dropped, the rest trimmed', recs.map(r => r.serial_num), ['1509436', '1669421']);
ok('each carries the work order, the source and the date of the import',
   [recs[0].work_order_id, recs[0].source, recs[0].inspection_date], ['98378', 'office', '2026-11-13']);
ok('no work order is still a record, just without one',
   R.toRecords([{ serial: '1' }], '  ', 'x', 'office', '2026-11-13')[0].work_order_id, undefined);
ok('the date is local, not UTC', R.localDate(new Date(2026, 10, 13, 23, 30)), '2026-11-13');

// ── Everything saves ─────────────────────────────────────────────────────────
let sb = server();
let res = await R.recordImport(sb, box, recs, 'acct-nate');
ok('all saved, in one round trip', [res.written, res.failed, sb.calls], [2, 0, ['record_inspections']]);
ok('nothing left waiting', fs.existsSync(box), false);

// ── One bad ladder ───────────────────────────────────────────────────────────
const many = R.toRecords(Array.from({ length: 150 }, (_, i) => ({ serial: String(1000 + i) })),
                         '98378', 'Nate', 'office', '2026-11-13');
sb = server({ refuse: s => s === '1042' ? 'value too long' : null });
res = await R.recordImport(sb, box, many, 'acct-nate');
ok('one refused ladder costs one record, not its batch', [res.written, res.failed], [149, 1]);
ok('and the reason is reported', res.errors, ['value too long']);
ok('the refused one is kept, with its account and date',
   R.readOutbox(box).map(e => [e.record.serial_num, e.account_id, e.record.inspection_date]),
   [['1042', 'acct-nate', '2026-11-13']]);

// ── Network down: everything is kept ─────────────────────────────────────────
fs.rmSync(box, { force: true });
sb = server({ down: true });
res = await R.recordImport(sb, box, recs, 'acct-nate');
ok('a dead connection is a reported failure, not a throw', [res.written, res.failed, res.errors], [0, 2, ['fetch failed']]);
ok('both kept', R.readOutbox(box).length, 2);

// ── Retried later, only in the same account ──────────────────────────────────
// One more waiting for Michael's account (the office was acting as him).
const kept = R.readOutbox(box);
kept.push({ account_id: 'acct-michael', record: { serial_num: '777', inspection_date: '2026-11-01' }, tries: 1 });
fs.writeFileSync(box, JSON.stringify(kept));

sb = server();
let fl = await R.flushOutbox(sb, box, 'acct-nate');
ok('Nate\'s two are saved when working as Nate', [fl.written, fl.stillFailing], [2, 0]);
ok('with the date they were imported, not today',
   sb.saved.map(r => r.inspection_date), ['2026-11-13', '2026-11-13']);
ok('Michael\'s is left alone and counted', [fl.otherAccounts, R.readOutbox(box).map(e => e.record.serial_num)],
   [1, ['777']]);

sb = server({ refuse: () => 'No account — contact your administrator' });
fl = await R.flushOutbox(sb, box, 'acct-michael');
ok('still refused: kept, with the new reason and another try counted',
   [fl.stillFailing, R.readOutbox(box)[0].tries, R.readOutbox(box)[0].error],
   [1, 2, 'No account — contact your administrator']);

sb = server();
fl = await R.flushOutbox(sb, box, 'acct-michael');
ok('saved once it is accepted, and the file is gone', [fl.written, fs.existsSync(box)], [1, false]);

// ── Parts go with the record (1.15.12) ───────────────────────────────────────
// A destroyed ladder is one billed with a destroy part (PMCD4…); the database
// can only show it if the office sends the parts it billed.
const withParts = R.toRecords([{ serial: '1135318', parts: [
  { searchTerm: 'PMCD4', quantity: 1 }, { searchTerm: 'G13', quantity: 2 },
  { searchTerm: '  ', quantity: 1 }, { searchTerm: 'X', quantity: 0 }] }], '98378', 'Nate', 'office', '2026-11-14');
ok('the CSV parser\'s parts become { name, qty }, blanks and zero quantities dropped',
   withParts[0].parts, [{ name: 'PMCD4', qty: 1 }, { name: 'G13', qty: 2 }]);
ok('a row with no parts sends none (the server keeps whatever it had)',
   'parts' in R.toRecords([{ serial: '1' }], 'W', 'x', 'office', '2026-11-14')[0], false);
ok('[{ name, qty }] passes through, a missing quantity is 1',
   R.toParts([{ name: 'PM36' }, { name: 'TRL-3', qty: '2' }]), [{ name: 'PM36', qty: 1 }, { name: 'TRL-3', qty: 2 }]);
ok('nonsense is no parts, not a throw', [R.toParts(null), R.toParts('PMCD4'), R.toParts([null, 5])], [[], [], []]);

// ── A placeholder serial is reported, never queued (39) ──────────────────────
fs.rmSync(box, { force: true });
const NA = '"N/A" is not a serial number — use the number on the item, or a spare number if it has none';
sb = server({ refuse: s => s === 'N/A' ? NA : null });
res = await R.recordImport(sb, box, R.toRecords([{ serial: '7001' }, { serial: 'N/A' }, { serial: '7002' }],
                                                 'W', 'x', 'office', '2026-11-14'), 'acct-nate');
ok('the good ladders save', res.written, 2);
ok('the N/A one is reported by serial, with the server\'s words', res.refused, [{ serial: 'N/A', error: NA }]);
ok('and is not queued — it could never succeed', [res.queued, fs.existsSync(box)], [0, false]);

// One queued before 1.15.12 is dropped on the next retry, and reported.
fs.writeFileSync(box, JSON.stringify([
  { account_id: 'acct-nate', record: { serial_num: 'N/A' }, error: 'old', tries: 3 },
  { account_id: 'acct-nate', record: { serial_num: '7003' }, error: 'old', tries: 1 }]));
fl = await R.flushOutbox(sb, box, 'acct-nate');
ok('an old queued N/A is dropped and reported; the rest saves',
   [fl.written, fl.stillFailing, fl.refused.map(r => r.serial), fs.existsSync(box)], [1, 0, ['N/A'], false]);
ok('a network error is still kept, not mistaken for a refusal', R.isPermanent('fetch failed'), false);

// ── A damaged outbox is not an empty one that overwrites it ──────────────────
fs.writeFileSync(box, '[{"account_id":"a","record":{"serial_num":"1"}}');   // cut short
ok('a damaged file reads as nothing waiting', R.readOutbox(box), []);
ok('and is moved aside, not left to be overwritten',
   fs.readdirSync(dir).filter(f => f.startsWith('pending-inspections.json.unreadable-')).length, 1);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nAll office-records assertions passed.');
process.exit(fails ? 1 : 0);
