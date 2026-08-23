import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPartColumn, partColumns } from './csv-columns.js';
import { parsePartValue } from './part-value.js';

// Regression: "[Custom] " columns come from Lia Field's user-defined fields and are
// notes for the tech. They were being treated as part columns by src/csv-parser.ts
// (but not by electron/main.cjs), so the preview and the actual import disagreed and
// every custom field was searched for as a BSI part.
test('custom-field columns are never part columns', () => {
  assert.equal(isPartColumn('[Custom] Truck Bay'), false);
  assert.equal(isPartColumn('[Custom] Notes'), false);
});

test('ladder metadata columns are never part columns', () => {
  for (const h of ['Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description']) {
    assert.equal(isPartColumn(h), false, `${h} should not be a part column`);
  }
});

// Lubricated backs the BSI "P" checkbox. It must not be mistaken for a part number.
test('Lubricated is metadata, not a part', () => {
  assert.equal(isPartColumn('Lubricated'), false);
});

test('everything else is a part column', () => {
  for (const h of ['A', 'B', 'C&S', 'Rope', 'SLS-1', 'lbs', 'PM36']) {
    assert.equal(isPartColumn(h), true, `${h} should be a part column`);
  }
});

test('partColumns picks out only real parts from a field-app header row', () => {
  const headers = [
    'Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description',
    '[Custom] Truck Bay', '[Custom] Notes', 'Lubricated', 'A', 'B',
  ];
  assert.deepEqual(partColumns(headers), ['A', 'B']);
});

test('quantity parses as prefix, suffix, or bare', () => {
  assert.deepEqual(parsePartValue('(2) G13'), { searchTerm: 'G13', quantity: 2 });
  assert.deepEqual(parsePartValue('W44 (2)'), { searchTerm: 'W44', quantity: 2 });
  assert.deepEqual(parsePartValue('PM36'), { searchTerm: 'PM36', quantity: 1 });
});

test('blank and missing part cells are skipped', () => {
  assert.equal(parsePartValue(''), null);
  assert.equal(parsePartValue('   '), null);
  assert.equal(parsePartValue(undefined), null);
  assert.equal(parsePartValue(null), null);
});
