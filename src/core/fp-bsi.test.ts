import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFpBoxRecords, mergeParts, groupByWorkOrder, diffFpAgainstWorkOrder,
  bsiSerialKey, FP_DESC_INSPECT, FP_DESC_REMOVE,
} from './fp-bsi.js';

// Every test here is about money or about a record landing on the wrong item.
// Those are the two ways this mapping can hurt somebody.

test('a passing inspection and a removal are billed as different work', () => {
  const { records } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1', overall_pass: true },
    { inspection_id: 'i2', work_order_id: 'WO-1', serial_num: 'H-2', overall_pass: false,
      discard_reason: 'Failed: Webbing' },
  ]);
  assert.equal(records[0].desc, FP_DESC_INSPECT);
  // A removal described as an inspection is a wrong line on a customer invoice.
  assert.equal(records[1].desc, FP_DESC_REMOVE);
  assert.match(records[1].detail, /Failed: Webbing/);
});

test('an item with no serial is skipped with a reason, never guessed at', () => {
  const { records, skipped } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: '  ' },
  ]);
  assert.equal(records.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /No serial/);
});

test('an inspection with no work order is skipped — there is nothing to bill it against', () => {
  const { records, skipped } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: null, serial_num: 'H-1' },
  ]);
  assert.equal(records.length, 0);
  assert.match(skipped[0].reason, /No work order/);
});

test('a work order can be supplied for inspections that lack one', () => {
  const { records } = buildFpBoxRecords(
    [{ inspection_id: 'i1', work_order_id: null, serial_num: 'H-1' }],
    { workOrderId: 'WO-9' },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].workOrderId, 'WO-9');
});

// BSI double-bills a duplicated box.
test('the same serial twice on one work order becomes one box', () => {
  const { records, skipped } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
    { inspection_id: 'i2', work_order_id: 'WO-1', serial_num: 'h 1' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /Already on this work order/);
});

test('but the same serial on two work orders is two boxes', () => {
  const { records } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
    { inspection_id: 'i2', work_order_id: 'WO-2', serial_num: 'H-1' },
  ]);
  assert.equal(records.length, 2);
});

test('serials match regardless of case and punctuation', () => {
  assert.equal(bsiSerialKey('h-1 a'), bsiSerialKey('H1A'));
  assert.equal(bsiSerialKey(''), '');
});

// A second add of the same part is a second line, and the customer pays twice.
test('repeated parts are summed rather than added twice', () => {
  const merged = mergeParts([
    { searchTerm: 'M23', quantity: 1 },
    { searchTerm: 'm23', quantity: 2 },
    { searchTerm: 'RC', quantity: 1 },
  ]);
  assert.deepEqual(merged, [
    { searchTerm: 'M23', quantity: 3 },
    { searchTerm: 'RC', quantity: 1 },
  ]);
});

test('a part with a missing or nonsense quantity counts as one, not zero', () => {
  const merged = mergeParts([
    { searchTerm: 'M23', quantity: 0 },
    { searchTerm: 'RC', quantity: Number.NaN },
  ]);
  assert.deepEqual(merged.map(p => p.quantity), [1, 1]);
});

test('a blank part name is dropped rather than searched for', () => {
  assert.deepEqual(mergeParts([{ searchTerm: '   ', quantity: 1 }]), []);
});

test('records are grouped so each work order is one BSI page', () => {
  const { records } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
    { inspection_id: 'i2', work_order_id: 'WO-2', serial_num: 'H-2' },
    { inspection_id: 'i3', work_order_id: 'WO-1', serial_num: 'H-3' },
  ]);
  const grouped = groupByWorkOrder(records);
  assert.equal(grouped.size, 2);
  assert.equal(grouped.get('WO-1')!.length, 2);
});

// The whole point of the diff: the web app is flaky, a run dies halfway, and
// re-running must not re-add what already landed.
test('a re-run adds only what is not already on the work order', () => {
  const { records } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
    { inspection_id: 'i2', work_order_id: 'WO-1', serial_num: 'H-2' },
  ]);
  const diff = diffFpAgainstWorkOrder(records, ['h 1']);
  assert.deepEqual(diff.toAdd.map(r => r.serialNum), ['H-2']);
  assert.deepEqual(diff.alreadyThere.map(r => r.serialNum), ['H-1']);
});

test('an empty work order means everything still has to go', () => {
  const { records } = buildFpBoxRecords([
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
  ]);
  assert.equal(diffFpAgainstWorkOrder(records, []).toAdd.length, 1);
});

test('nothing in, nothing out — and no throw', () => {
  const r = buildFpBoxRecords([]);
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(groupByWorkOrder([]).size, 0);
});
