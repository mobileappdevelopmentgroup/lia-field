// Fall protection, as BSI actually bills it.
//
// This file replaces one that tested the opposite model — one box per
// inspected item, each with its own serial — and passed the whole time. It
// checked the mapping against itself and never against BSI, which is exactly
// how a wrong premise survives a green suite. Work order 98471 settled it:
// ONE box per work order, items collapsed onto it as parts by equipment type.
//
// The values below are read off that work order, not invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFpBoxRecords, fpBoxSerial, codeForType, diffFpAgainstWorkOrder,
  fpBoxAsLadderRecord, bsiSerialKey, mergeParts,
  FP_BOX_DESC, FP_BOX_TYPE, FP_BOX_INFO,
  type FpInspectionForBsi,
} from './fp-bsi.js';

const item = (o: Partial<FpInspectionForBsi>): FpInspectionForBsi => ({
  inspection_id: o.inspection_id ?? Math.random().toString(36).slice(2),
  work_order_id: o.work_order_id ?? 'WO-1',
  serial_num: o.serial_num ?? 'S-' + Math.random().toString(36).slice(2, 6),
  equipment_type: o.equipment_type ?? 'Body harness',
  ...o,
});

test('one work order makes exactly one box', () => {
  const { records } = buildFpBoxRecords([
    item({ equipment_type: 'Body harness' }),
    item({ equipment_type: 'Lanyard' }),
    item({ equipment_type: 'Body harness' }),
  ]);
  assert.equal(records.length, 1);
});

test('the box carries the values read off work order 98471', () => {
  const { records } = buildFpBoxRecords([item({ work_order_id: '98471' })]);
  assert.equal(records[0].serialNum, '111198471');
  assert.equal(records[0].desc, FP_BOX_DESC);
  assert.equal(FP_BOX_DESC, 'Fall Protection');
  assert.equal(FP_BOX_TYPE, 'Other');
  assert.equal(FP_BOX_INFO, 'Other');
});

test('the serial is derived, so a re-run recognises its own box', () => {
  // The whole reason double-billing is preventable. An invented serial would
  // look like a new box every time.
  assert.equal(fpBoxSerial('98471'), '111198471');
  assert.equal(fpBoxSerial('WO-98471'), '1111WO98471');
  assert.equal(fpBoxSerial('98471'), fpBoxSerial('98471'));
});

test('items become parts by type, with the quantity as the count', () => {
  const { records, lines } = buildFpBoxRecords([
    item({ equipment_type: 'Body harness' }),
    item({ equipment_type: 'Body harness' }),
    item({ equipment_type: 'Body harness' }),
    item({ equipment_type: 'Lanyard' }),
    item({ equipment_type: 'SRL (self-retracting lifeline)' }),
  ]);
  assert.deepEqual(records[0].parts, [
    { searchTerm: 'FP1', quantity: 3 },
    { searchTerm: 'FP2', quantity: 1 },
    { searchTerm: 'FP3', quantity: 1 },
  ]);
  assert.equal(lines.find(l => l.code === 'FP1')!.description, 'BODY HARNESS INSPECTION');
});

test('every one of the eight confirmed types maps', () => {
  const expected: Array<[string, string]> = [
    ['Body harness', 'FP1'],
    ['Lanyard', 'FP2'],
    ['SRL (self-retracting lifeline)', 'FP3'],
    ['Climbing belt', 'FP4'],
    ['Pole climbing device', 'FP6'],
    ['Positioning strap', 'FP7'],
    ['Self rescue device', 'FP8'],
    ['Self rescue with bag', 'FP9'],
  ];
  for (const [name, code] of expected) {
    assert.equal(codeForType(name)?.code, code, name);
  }
});

test('the six the office has not mapped are inspected and NOT invoiced', () => {
  // Named, never dropped, and never billed under a neighbouring code — a wrong
  // code bills a customer quietly and consistently, which nobody catches until
  // an audit.
  const unmapped = [
    'Crane lift sling', 'Tie off adaptor', 'Rescue device — R550',
    'Temporary horizontal lifeline', 'Vertical lifelines and fall arresters',
    'Positioning lanyard',
  ];
  for (const name of unmapped) {
    assert.equal(codeForType(name), null, name);
  }

  const { records, skipped } = buildFpBoxRecords([
    item({ serial_num: 'H-1', equipment_type: 'Body harness' }),
    item({ serial_num: 'C-9', equipment_type: 'Crane lift sling' }),
  ]);
  assert.deepEqual(records[0].parts, [{ searchTerm: 'FP1', quantity: 1 }]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].serial_num, 'C-9');
  assert.match(skipped[0].reason, /no billing code/i);
  assert.match(skipped[0].reason, /inspected, not invoiced/i);
});

test('a type name is matched however it is spelled or cased', () => {
  assert.equal(codeForType('BODY HARNESS')?.code, 'FP1');
  assert.equal(codeForType('body_harness')?.code, 'FP1');
  assert.equal(codeForType('  Self Rescue Device W Bag ')?.code, 'FP9');
  assert.equal(codeForType(''), null);
  assert.equal(codeForType(null), null);
});

test('the same item counted twice in one run is billed once', () => {
  const { records, skipped } = buildFpBoxRecords([
    item({ serial_num: 'H-1', equipment_type: 'Body harness' }),
    item({ serial_num: 'h-1', equipment_type: 'Body harness' }),
  ]);
  assert.deepEqual(records[0].parts, [{ searchTerm: 'FP1', quantity: 1 }]);
  assert.match(skipped[0].reason, /already counted/i);
});

test('an item from another work order never lands on this invoice', () => {
  const { records, skipped } = buildFpBoxRecords([
    item({ work_order_id: 'WO-1', equipment_type: 'Body harness' }),
    item({ work_order_id: 'WO-2', serial_num: 'X-2', equipment_type: 'Lanyard' }),
  ]);
  assert.equal(records[0].workOrderId, 'WO-1');
  assert.deepEqual(records[0].parts, [{ searchTerm: 'FP1', quantity: 1 }]);
  assert.match(skipped.find(s => s.serial_num === 'X-2')!.reason, /not WO-1/);
});

test('an item with no work order is named, not billed', () => {
  const { records, skipped } = buildFpBoxRecords([
    item({ work_order_id: null, serial_num: 'N-1' }),
  ]);
  assert.equal(records.length, 0);
  assert.match(skipped[0].reason, /no work order/i);
});

test('nothing billable makes no box at all', () => {
  const { records, lines } = buildFpBoxRecords([
    item({ equipment_type: 'Crane lift sling' }),
  ]);
  assert.equal(records.length, 0);
  assert.equal(lines.length, 0);
});

test('the box knows every inspection it billed for', () => {
  // A crash after the box lands must not leave half of them looking unbilled.
  const { records } = buildFpBoxRecords([
    item({ inspection_id: 'a', equipment_type: 'Body harness' }),
    item({ inspection_id: 'b', equipment_type: 'Lanyard' }),
  ]);
  assert.deepEqual(records[0].inspectionIds.sort(), ['a', 'b']);
});

test('a second run finds its own box and adds nothing', () => {
  const { records } = buildFpBoxRecords([item({ work_order_id: '98471' })]);
  const fresh = diffFpAgainstWorkOrder(records, ['1719761', '1719760']);
  assert.equal(fresh.toAdd.length, 1);

  const rerun = diffFpAgainstWorkOrder(records, ['1719761', '111198471']);
  assert.equal(rerun.toAdd.length, 0);
  assert.equal(rerun.alreadyThere.length, 1);
});

test('the box is handed to the ladder importer as a ladder record', () => {
  // Fall protection is not a second form, so it does not get a second
  // importer: it is one box on the ladder form with different values.
  const { records } = buildFpBoxRecords([item({ work_order_id: '98471' })]);
  const ladder = fpBoxAsLadderRecord(records[0]);
  assert.equal(ladder.serialNum, '111198471');
  assert.equal(ladder.type, 'Other');            // #WoLadType
  assert.equal(ladder.desc, 'Fall Protection');  // #WoLadDesc
  assert.equal(ladder.brand, 'Other');           // feeds the Information column
  assert.equal(ladder.length, '');               // a box has no length
  assert.deepEqual(ladder.parts, records[0].parts);
});

test('serial keys ignore case and punctuation, as BSI does', () => {
  assert.equal(bsiSerialKey('wo-98 471'), 'WO98471');
  assert.equal(bsiSerialKey(''), '');
});

test('repeated parts are summed, never listed twice', () => {
  // BSI treats a second add of the same part as a second line, and the
  // customer pays for both.
  assert.deepEqual(
    mergeParts([
      { searchTerm: 'FP1', quantity: 2 },
      { searchTerm: 'fp1', quantity: 3 },
      { searchTerm: '', quantity: 9 },
    ]),
    [{ searchTerm: 'FP1', quantity: 5 }],
  );
});
