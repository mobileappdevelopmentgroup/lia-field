import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecords, unionParts, serialKey, type MergeRecord } from './merge.js';

const rec = (o: Partial<MergeRecord>): MergeRecord => ({
  clientId: Math.random().toString(36).slice(2),
  serialNum: 'SN-1', scope: 'ladder', capturedAt: '2026-08-01T10:00:00Z',
  techName: 'Tech A', ...o,
} as MergeRecord);

test('serial matching ignores punctuation and case, like the database', () => {
  assert.equal(serialKey('h-4471 a'), 'H4471A');
  const r = mergeRecords([
    rec({ serialNum: 'H-4471-A', techName: 'A' }),
    rec({ serialNum: 'h4471a', techName: 'B', capturedAt: '2026-08-01T11:00:00Z' }),
  ]);
  assert.equal(r.items.length, 1, 'the same item typed two ways is one item');
  assert.equal(r.items[0].contributors.length, 2);
});

test('a ladder and a fall-protection item may share a serial', () => {
  const r = mergeRecords([
    rec({ serialNum: 'X-1', scope: 'ladder' }),
    rec({ serialNum: 'X-1', scope: 'fall_protection' }),
  ]);
  assert.equal(r.items.length, 2);
});

test('the later capture wins, and nothing is discarded', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z', length: '24' }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', length: '28' }),
  ]);
  assert.equal(r.items[0].winner.techName, 'B');
  assert.equal(r.items[0].winner.length, '28');
  assert.equal(r.items[0].contributors.length, 2, 'the earlier record is kept');
});

test('server upload time breaks a tie, because a device clock can be wrong', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z', uploadedAt: '2026-08-01T18:00:00Z' }),
    rec({ techName: 'B', capturedAt: '2026-08-01T10:00:00Z', uploadedAt: '2026-08-01T19:00:00Z' }),
  ]);
  assert.equal(r.items[0].winner.techName, 'B');
});

// Safety outranks recency.
test('a FAIL beats a later PASS', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z', overallPass: false, scope: 'fall_protection' }),
    rec({ techName: 'B', capturedAt: '2026-08-01T16:00:00Z', overallPass: true, scope: 'fall_protection' }),
  ]);
  assert.equal(r.items[0].winner.overallPass, false, 'the condemned record wins');
  assert.equal(r.items[0].winner.techName, 'A');
  assert.equal(r.items[0].failOverrodePass, true, 'and the lead is told why');
});

test('disagreements are surfaced, not resolved quietly', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z', brand: 'Werner', length: '24' }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', brand: 'Werner', length: '28' }),
  ]);
  const fields = r.items[0].conflicts.map((c) => c.field);
  assert.deepEqual(fields, ['length'], 'only what actually differs');
  assert.equal(r.conflicted.length, 1);
  assert.equal(r.items[0].conflicts[0].values.length, 2, 'both values, both named');
});

test('agreement is not a conflict, and neither is a missing value', () => {
  const r = mergeRecords([
    rec({ techName: 'A', brand: 'Werner', length: '28' }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', brand: 'Werner', length: '' }),
  ]);
  assert.deepEqual(r.items[0].conflicts, []);
  assert.equal(r.conflicted.length, 0);
});

test('bookkeeping differences are not conflicts', () => {
  const r = mergeRecords([
    rec({ techName: 'A', deviceId: 'phone-1', clientId: 'c1' }),
    rec({ techName: 'B', deviceId: 'phone-2', clientId: 'c2', capturedAt: '2026-08-01T14:00:00Z' }),
  ]);
  assert.deepEqual(r.items[0].conflicts, []);
});

// Unioning parts double-adds them in BSI and double-bills the customer.
test('differing parts are reported but never merged automatically', () => {
  const r = mergeRecords([
    rec({ techName: 'A', parts: [{ searchTerm: 'M23', quantity: 1 }] }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', parts: [{ searchTerm: 'RC', quantity: 2 }] }),
  ]);
  assert.equal(r.items[0].conflicts.some((c) => c.field === 'parts'), true);
  assert.deepEqual(r.items[0].winner.parts, [{ searchTerm: 'RC', quantity: 2 }],
    'the winner keeps its own parts, not a union');
});

test('union is available, and takes the highest quantity rather than the sum', () => {
  const r = mergeRecords([
    rec({ techName: 'A', parts: [{ searchTerm: 'M23', quantity: 2 }, { searchTerm: 'RC', quantity: 1 }] }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', parts: [{ searchTerm: 'M23', quantity: 2 }] }),
  ]);
  const u = unionParts(r.items[0]).sort((a, b) => a.searchTerm.localeCompare(b.searchTerm));
  // Two techs each recording "2 rungs" saw the same two rungs.
  assert.deepEqual(u, [{ searchTerm: 'M23', quantity: 2 }, { searchTerm: 'RC', quantity: 1 }]);
});

test('identical parts are not a conflict', () => {
  const r = mergeRecords([
    rec({ techName: 'A', parts: [{ searchTerm: 'M23', quantity: 1 }] }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', parts: [{ searchTerm: 'M23', quantity: 1 }] }),
  ]);
  assert.equal(r.items[0].conflicts.length, 0);
});

// Without tombstones a deletion silently never propagates.
test('a deletion removes the item when it is the latest word', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z' }),
    rec({ techName: 'A', capturedAt: '2026-08-01T14:00:00Z', deleted: true }),
  ]);
  assert.equal(r.items.length, 0);
  assert.deepEqual(r.tombstoned, ['SN-1']);
});

test('but re-capturing after a deletion brings the item back', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z', deleted: true }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', length: '28' }),
  ]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].winner.techName, 'B');
  assert.deepEqual(r.tombstoned, []);
});

// "Latest wins" is only as good as the clocks being compared.
test('a badly skewed device clock is flagged', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z' }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', clockSkewMs: 45 * 60 * 1000 }),
  ]);
  assert.equal(r.items[0].suspectClock, true);
});

test('a small skew is not flagged', () => {
  const r = mergeRecords([
    rec({ techName: 'A', capturedAt: '2026-08-01T10:00:00Z' }),
    rec({ techName: 'B', capturedAt: '2026-08-01T14:00:00Z', clockSkewMs: 4000 }),
  ]);
  assert.equal(r.items[0].suspectClock, undefined);
});

test('a three-tech work order merges into one clean set', () => {
  const r = mergeRecords([
    rec({ serialNum: 'A-1', techName: 'Ann' }),
    rec({ serialNum: 'A-2', techName: 'Ann' }),
    rec({ serialNum: 'B-1', techName: 'Ben' }),
    rec({ serialNum: 'A-1', techName: 'Ben', capturedAt: '2026-08-01T15:00:00Z', length: '32' }),
    rec({ serialNum: 'C-1', techName: 'Cal', scope: 'fall_protection' }),
  ]);
  assert.equal(r.items.length, 4, 'four distinct items');
  assert.equal(r.items.find((i) => i.serialNum === 'A-1')!.winner.techName, 'Ben');
  assert.deepEqual(r.contributorSummary.map((c) => [c.techName, c.captured]),
    [['Ann', 2], ['Ben', 2], ['Cal', 1]]);
});

test('one tech working alone produces no conflicts', () => {
  const r = mergeRecords([
    rec({ serialNum: 'A-1', techName: 'Ann' }),
    rec({ serialNum: 'A-2', techName: 'Ann' }),
  ]);
  assert.equal(r.items.length, 2);
  assert.equal(r.conflicted.length, 0);
});

test('an empty pull is not an error', () => {
  const r = mergeRecords([]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.contributorSummary, []);
});
