// Fall-protection history import: the spreadsheet → rows parser that Lia
// Office runs before anything is sent (electron/fp-history.cjs). The server
// re-checks every row (35_fp_history_import.sql); this is what the office sees
// in the preview, so it must say the same things the server would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseFpHistory, mapHeaders, toIso, slashOrder, mfgParts } = require('../../electron/fp-history.cjs');

const TODAY = '2026-10-14';
const parse = (headers: string[], rows: string[][]) =>
  parseFpHistory(rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))), headers, { today: TODAY });

test('headers are matched however the spreadsheet spells them', () => {
  const { map, unmapped } = mapHeaders(['Serial Number', 'DATE INSPECTED', 'Pass/Fail', 'Equipment Type',
    'Mfr', 'Model #', 'Manufacturer S/N', 'Lot No.', 'DOM', 'Tag #', 'Inspected By', 'WO #', 'Colour']);
  assert.deepEqual(map, {
    serial: 'Serial Number', inspection_date: 'DATE INSPECTED', result: 'Pass/Fail',
    equipment_type: 'Equipment Type', manufacturer: 'Mfr', model: 'Model #', mfr_serial: 'Manufacturer S/N',
    lot_number: 'Lot No.', mfg_date: 'DOM', tag_label: 'Tag #', inspector: 'Inspected By', work_order_id: 'WO #',
  });
  assert.deepEqual(unmapped, ['Colour'], 'a column nobody recognises is listed, not dropped silently');
});

test('the serial is the assigned number; the manufacturer\'s goes beside it', () => {
  const r = parse(['Serial #', 'Inspection Date', 'Result', 'Manufacturer Serial'],
                  [['BAT-1', '2025-03-12', 'Pass', 'MSA-998']]);
  assert.equal(r.rows[0].serial, 'BAT-1');
  assert.equal(r.rows[0].mfr_serial, 'MSA-998');
});

test('a bare "ID" column is never taken for the serial', () => {
  const r = parse(['ID', 'Inspection Date', 'Result'], [['17', '2025-03-12', 'Pass']]);
  assert.match(r.error, /No column for the serial/);
});

test('no serial or date column is an error naming the columns found', () => {
  const r = parse(['Thing', 'When'], [['a', 'b']]);
  assert.match(r.error, /serial .* or the inspection date/);
  assert.match(r.error, /Columns found: Thing, When/);
});

test('dates: ISO as is; slashes read the way the rest of the file says', () => {
  assert.equal(toIso('2025-3-4', null), '2025-03-04');
  assert.equal(slashOrder(['03/04/2025', '25/12/2024']), 'dmy');
  assert.equal(slashOrder(['03/04/2025', '12/25/2024']), 'mdy');
  assert.equal(slashOrder(['03/04/2025', '05/06/2025']), null);
  assert.equal(slashOrder(['13/01/2025', '01/13/2025']), 'conflict');
  assert.equal(toIso('03/04/2025', 'dmy'), '2025-04-03');
  assert.equal(toIso('03/04/2025', 'mdy'), '2025-03-04');
  assert.equal(toIso('3/4/25', 'mdy'), '2025-03-04');
  assert.equal(toIso('Jan 15 2025', null), '2025-01-15');
  assert.equal(toIso('2025-02-30', null), null, 'a day that does not exist is not a date');
});

test('a file that settles nothing is read month-first, and says so', () => {
  const r = parse(['Serial', 'Date', 'Result'], [['A', '03/04/2025', 'pass']]);
  assert.equal(r.dateOrder, null);
  assert.equal(r.rows[0].inspection_date, '2025-03-04');
});

test('a file that writes dates both ways round is refused whole', () => {
  const r = parse(['Serial', 'Date', 'Result'], [['A', '13/01/2025', 'pass'], ['B', '01/13/2025', 'pass']]);
  assert.match(r.error, /both day-first and month-first/);
  assert.equal(r.rows.length, 0);
});

test('pass and fail in the words people use; anything else is reported, not guessed', () => {
  const r = parse(['Serial', 'Date', 'Status'],
    [['A', '2025-01-01', 'PASSED'], ['B', '2025-01-01', 'Out of service'], ['C', '2025-01-01', 'Y'],
     ['D', '2025-01-01', 'needs look'], ['E', '2025-01-01', '']]);
  assert.deepEqual(r.rows.map((x: any) => x.result), ['pass', 'fail', 'pass']);
  assert.deepEqual(r.skipped.map((s: any) => s.row), [5, 6]);
  assert.equal(r.needsResultConfirm, false);
});

test('no result column: nothing is assumed — the office must confirm every row passed', () => {
  const r = parse(['Serial', 'Date'], [['A', '2025-01-01']]);
  assert.equal(r.needsResultConfirm, true);
  assert.equal(r.rows[0].result, null);
});

test('rows that cannot be imported say why, by spreadsheet row', () => {
  const r = parse(['Serial', 'Date', 'Result'],
    [['', '2025-01-01', 'pass'], ['B', 'soon', 'pass'], ['C', '2027-01-01', 'pass'],
     ['D', '2025-01-01', 'pass'], ['d', '2025-01-01', 'fail'], ['', '', '']]);
  assert.deepEqual(r.skipped, [
    { row: 2, reason: 'No serial' },
    { row: 3, serial: 'B', reason: '"soon" is not a date' },
    { row: 4, serial: 'C', reason: '2027-01-01 is in the future' },
    { row: 6, serial: 'd', reason: 'Same item and date as row 5' },
  ]);
  assert.equal(r.rows.length, 1, 'a blank line is neither a row nor a problem');
});

test('types: our names become our slugs; anything else is kept in the file\'s words and listed', () => {
  const r = parse(['Serial', 'Date', 'Result', 'Type'],
    [['A', '2025-01-01', 'pass', 'Full Body Harness'], ['B', '2025-01-01', 'pass', 'SRLs'],
     ['C', '2025-01-01', 'pass', 'Rope grab'], ['D', '2025-01-01', 'pass', 'rope grab']]);
  assert.deepEqual(r.rows.map((x: any) => x.equipment_type), ['body_harness', 'srl', 'Rope grab', 'rope grab']);
  assert.deepEqual(r.unknownTypes, [{ text: 'Rope grab', count: 1 }, { text: 'rope grab', count: 1 }]);
});

test('date of manufacture becomes month and year', () => {
  assert.deepEqual(mfgParts('06/2021', 'mdy'), { mfg_month: 6, mfg_year: 2021 });
  assert.deepEqual(mfgParts('2021-06', 'mdy'), { mfg_month: 6, mfg_year: 2021 });
  assert.deepEqual(mfgParts('2021', 'mdy'), { mfg_year: 2021 });
  assert.deepEqual(mfgParts('June 2021', 'mdy'), { mfg_month: 6, mfg_year: 2021 });
  assert.deepEqual(mfgParts('', 'mdy'), {});
});

test('the template parses cleanly through the same path', () => {
  const { SAMPLE } = require('../../electron/fp-history.cjs');
  const lines = SAMPLE.split('\r\n').map((l: string) => l.split(','));
  const r = parse(lines[0], lines.slice(1));
  assert.equal(r.error, undefined);
  assert.equal(r.skipped.length, 0);
  assert.deepEqual(r.unmapped, []);
  assert.deepEqual(r.rows.map((x: any) => [x.serial, x.result, x.equipment_type]),
    [['BAT-1001', 'pass', 'body_harness'], ['BAT-1002', 'pass', 'lanyard'], ['BAT-1003', 'fail', 'srl']]);
  assert.deepEqual([r.rows[0].mfg_month, r.rows[0].mfg_year], [6, 2021]);
});
