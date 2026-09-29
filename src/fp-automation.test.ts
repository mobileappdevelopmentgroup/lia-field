import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrapeFpSerials, diffFpAgainstWorkOrder } from './fp-automation.js';
import { buildFpBoxRecords, type FpInspectionForBsi } from './core/fp-bsi.js';

// This file used to be entirely about the preflight — what happens when BSI's
// page is not the one the code was written for. That preflight existed because
// FP_FORM was a guess at a fall-protection form nobody had seen, and the
// alternative to refusing was forty boxes of wrong values on a live work order.
//
// The form turned out to be the ladder form. There is no second importer now,
// so there is nothing to refuse: the box goes through runAutomation(), which
// has its own diff, retries and verification and has been run against real
// work orders for months.
//
// What is left to test here is the part that is still this file's own job:
// reading what is already on the page, and never adding the box twice.

const item = (o: Partial<FpInspectionForBsi>): FpInspectionForBsi => ({
  inspection_id: o.inspection_id ?? 'i1',
  work_order_id: o.work_order_id ?? '98471',
  serial_num: o.serial_num ?? 'H-1',
  equipment_type: o.equipment_type ?? 'Body harness',
  ...o,
});

test('existing box serials are read off the page', async () => {
  const page = { evaluate: async () => ['1719761', '111198471'] };
  assert.deepEqual(await scrapeFpSerials(page as never), ['1719761', '111198471']);
});

test('a page that cannot be read gives an empty list, not a crash', async () => {
  // A page mid-reload is exactly when this throws, and throwing here would
  // kill a run before it started. Empty is safe: the box serial is derived,
  // so the ladder importer's own diff still catches a repeat.
  const page = { evaluate: async () => { throw new Error('Execution context destroyed'); } };
  assert.deepEqual(await scrapeFpSerials(page as never), []);
});

test('junk from the page is filtered rather than trusted', async () => {
  const page = { evaluate: async () => ['1719761', null, 42, ''] };
  assert.deepEqual(await scrapeFpSerials(page as never), ['1719761', '']);
});

test('a work order that already has its box gets nothing added', async () => {
  const { records } = buildFpBoxRecords([item({})]);
  const { toAdd, alreadyThere } = diffFpAgainstWorkOrder(records, ['111198471']);
  assert.equal(toAdd.length, 0);
  assert.equal(alreadyThere.length, 1);
});

test('a work order with other boxes still gets its fall protection box', async () => {
  const { records } = buildFpBoxRecords([item({})]);
  const { toAdd } = diffFpAgainstWorkOrder(records, ['1719761', '1719760']);
  assert.equal(toAdd.length, 1);
  assert.equal(toAdd[0].serialNum, '111198471');
});
