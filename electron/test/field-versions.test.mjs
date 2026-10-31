// Grouping a work order's rows into items with their versions.
//
// What the lead has to be able to read off one item: what the field collected,
// what the office changed and why, what reached BSI — and, for a correction
// made after BSI had it, that re-importing will not fix it.
//
// Run with `node electron/test/field-versions.test.mjs`.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { groupVersions, parseParts } = require('../field-versions.cjs');

let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

const L = (o) => Object.assign({
  asset_id: 'a1', serial_num: 'L-1', inspection_date: '2026-10-29', version: 1,
  is_current: true, is_deleted: false, source: 'field', captured_at: '2026-10-29T14:00:00Z',
  created_at: '2026-10-29T14:05:00Z', bsi_pushed_at: null, collector_name: 'Ann',
  brand: 'Werner', type: 'Extension', length: '24', notes: null, work_order_id: 'WO-1',
  parts: [{ name: 'G13', qty: 2 }], lubricated: null, has_leveler: null, has_claw: null, has_vrung: null,
}, o);

// ── A field record, pushed, then corrected ──────────────────────────────────
let items = groupVersions({
  ladders: [
    L({ id: 'v1', is_current: false, bsi_pushed_at: '2026-10-29T18:00:00Z', bsi_box_ref: 'box-3' }),
    L({ id: 'v2', version: 2, source: 'office_amend', brand: 'Louisville', created_at: '2026-10-30T12:00:00Z' }),
  ],
  audits: [{ scope: 'ladder', inspection_id: 'v2', action: 'amend', reason: 'wrong brand', actor_name: 'Office', created_at: '2026-10-30T12:00:00Z' }],
});
ok('two versions of one ladder on one day are one item', items.length, 1);
let it = items[0];
ok('the current one is the correction', it.current.id, 'v2');
ok('the field version is kept, labelled as the field\'s', it.versions[0].origin, 'field');
ok('the correction is labelled as the office\'s', it.versions[1].origin, 'corrected');
ok('what changed is spelled out', it.versions[1].changes, [{ field: 'brand', from: 'Werner', to: 'Louisville' }]);
ok('with the reason beside it', it.versions[1].audit.map(a => a.reason), ['wrong brand']);
ok('the field version says when it reached BSI', it.versions[0].bsiPushedAt, '2026-10-29T18:00:00Z');
ok('a correction after BSI is named as a fix to make in BSI', it.state, 'changed_after_bsi');
ok('and can be undone, back to the field version', it.canUndo, true);
ok('delete takes every live version, newest first', it.liveIds, ['v2', 'v1']);

// ── Pushed, never changed ───────────────────────────────────────────────────
items = groupVersions({ ladders: [L({ id: 'p1', bsi_pushed_at: '2026-10-29T18:00:00Z' })] });
ok('a pushed record is in BSI', items[0].state, 'in_bsi');
ok('and a field record has nothing to undo', items[0].canUndo, false);

// ── Re-sent from the phone is not a correction ──────────────────────────────
items = groupVersions({ ladders: [L({ id: 'r1', is_current: false }), L({ id: 'r2', version: 2 })] });
ok('a second field version is a re-send, not the office', items[0].versions[1].origin, 'field_resend');
ok('and is not offered as a correction to undo', items[0].canUndo, false);
ok('nor flagged as changed after BSI when neither went', items[0].state, 'not_in_bsi');

// ── Deleted ─────────────────────────────────────────────────────────────────
items = groupVersions({ ladders: [
  L({ id: 'd1', is_current: false, is_deleted: true }),
  L({ id: 'd2', version: 2, source: 'office_amend', is_current: false, is_deleted: true }),
  L({ id: 'x1', asset_id: 'a2', serial_num: 'L-2' }),
] });
const del = items.find(i => i.serialNum === 'L-1');
ok('a deleted item is still listed', del.state, 'deleted');
ok('restore brings back the item as it last stood', del.restoreId, 'd2');
ok('live items sort ahead of deleted ones', items.map(i => i.serialNum), ['L-2', 'L-1']);

// ── Moved off this work order ───────────────────────────────────────────────
items = groupVersions({ ladders: [L({ id: 'm1', is_current: false })] });
ok('a version superseded by one on another work order reads as moved', items[0].state, 'moved');

// ── Same serial, different days, and fall protection beside ladders ─────────
items = groupVersions({
  ladders: [L({ id: 'a', inspection_date: '2026-10-28' }), L({ id: 'b' })],
  fp: [{ id: 'f1', asset_id: 'h1', inspection_date: '2026-10-29', version: 1, is_current: true,
         is_deleted: false, source: 'field', uploaded_at: '2026-10-29T15:00:00Z', manufacturer: 'MSA',
         assets: { serial_raw: 'H-1' } }],
  audits: [{ scope: 'ladder', inspection_id: 'f1', action: 'amend', reason: 'wrong table', created_at: 'x' }],
});
ok('one item per day', items.filter(i => i.scope === 'ladder').length, 2);
const h = items.find(i => i.scope === 'fall_protection');
ok('fall protection takes its serial from the asset', h.serialNum, 'H-1');
ok('and when it reached the server from uploaded_at', h.versions[0].receivedAt, '2026-10-29T15:00:00Z');
ok('a ladder audit row never lands on an FP record with the same id', h.versions[0].audit, []);

// ── Parts as typed ──────────────────────────────────────────────────────────
ok('parts parse with quantities', parseParts('G13 x2, W44, g13').parts, [{ name: 'G13', qty: 3 }, { name: 'W44', qty: 1 }]);
ok('blank is no parts', parseParts('').parts, []);
ok('an absurd quantity is refused', !!parseParts('G13 x0').error, true);

console.log(fails ? `\n${fails} failed` : '\nAll field-version assertions passed.');
process.exit(fails ? 1 : 0);
