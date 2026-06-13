import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVerificationLoop } from './verify.js';
import type { LadderRecord, LadderResult, WorkOrderBox } from './types.js';

const noWait = async () => {};

const records: LadderRecord[] = [
  { serialNum: 'A', truckId: '', brand: '', type: '', length: '', desc: '',
    parts: [{ searchTerm: 'M23', quantity: 1 }, { searchTerm: 'RC', quantity: 1 }] },
  { serialNum: 'B', truckId: '', brand: '', type: '', length: '', desc: '',
    parts: [{ searchTerm: 'M16', quantity: 1 }] },
  { serialNum: 'C', truckId: '', brand: '', type: '', length: '', desc: '',
    parts: [{ searchTerm: 'R28L', quantity: 1 }] },
];

function startingResults(): LadderResult[] {
  return records.map((r) => ({
    serialNum: r.serialNum,
    status: 'success',
    partsTotal: r.parts.length,
    partsOk: r.parts.length,
    partResults: r.parts.map((p) => ({ searchTerm: p.searchTerm, status: 'success' as const })),
  }));
}

// Simulates a CSV import that initially left SN A missing its "RC" part and
// SN B's box entirely absent. The first verification pass must catch this
// mismatch; the fix attempt only adds the missing box for B (still without
// its part) and adds RC to A. A second mismatch (B missing M16) forces a
// third pass before everything finally matches — exercising the "2-3 loop"
// retry path end to end.
test('verification loop fixes mismatches across 3 passes', async () => {
  let state = 0;
  const boxesByState: WorkOrderBox[][] = [
    // Pass 1: A is missing RC, B's box doesn't exist yet, C is complete.
    [
      { selector: '#box-1', serialNum: 'A', partNums: ['M23'] },
      { selector: '#box-3', serialNum: 'C', partNums: ['R28L'] },
    ],
    // After fix 1: A is now complete, B's box exists but still has no parts.
    [
      { selector: '#box-1', serialNum: 'A', partNums: ['M23', 'RC'] },
      { selector: '#box-2', serialNum: 'B', partNums: [] },
      { selector: '#box-3', serialNum: 'C', partNums: ['R28L'] },
    ],
    // After fix 2: B now has its M16 part — everything matches.
    [
      { selector: '#box-1', serialNum: 'A', partNums: ['M23', 'RC'] },
      { selector: '#box-2', serialNum: 'B', partNums: ['M16'] },
      { selector: '#box-3', serialNum: 'C', partNums: ['R28L'] },
    ],
  ];

  const fixCalls: unknown[] = [];
  const ladderResults = startingResults();

  const outcome = await runVerificationLoop(records, ladderResults, new Set(), {
    wait: noWait,
    scrapeBoxes: async () => boxesByState[state]!,
    fixGaps: async (gaps): Promise<LadderResult[]> => {
      fixCalls.push(gaps);
      state++; // advance to the post-fix work-order state
      const fromMissing: LadderResult[] = gaps.missingBoxes.map((r) => ({
        serialNum: r.serialNum,
        status: 'partial',
        partsTotal: r.parts.length,
        partsOk: 0,
        partResults: [],
      }));
      const fromGaps: LadderResult[] = gaps.existingWithGaps.map((g) => ({
        serialNum: g.record.serialNum,
        status: 'success',
        partsTotal: g.record.parts.length,
        partsOk: g.record.parts.length,
        partResults: g.record.parts.map((p) => ({ searchTerm: p.searchTerm, status: 'success' })),
      }));
      return [...fromMissing, ...fromGaps];
    },
  });

  assert.equal(outcome.verification.passes, 3);
  assert.equal(outcome.verification.fixAttempts, 2);
  assert.equal(outcome.verification.matched, true);
  assert.deepEqual(outcome.verification.missingBoxes, []);
  assert.deepEqual(outcome.verification.missingParts, []);
  assert.equal(fixCalls.length, 2);

  // Pass 1's fix should have targeted A's missing RC and B's missing box.
  const firstGaps = fixCalls[0] as { missingBoxes: LadderRecord[]; existingWithGaps: { record: LadderRecord }[] };
  assert.deepEqual(firstGaps.missingBoxes.map((r) => r.serialNum), ['B']);
  assert.deepEqual(firstGaps.existingWithGaps.map((g) => g.record.serialNum), ['A']);

  // Pass 2's fix should target only B's still-missing M16.
  const secondGaps = fixCalls[1] as { missingBoxes: LadderRecord[]; existingWithGaps: { record: LadderRecord }[] };
  assert.deepEqual(secondGaps.missingBoxes.map((r) => r.serialNum), []);
  assert.deepEqual(secondGaps.existingWithGaps.map((g) => g.record.serialNum), ['B']);
});

// If the work order never converges with the CSV, the loop should stop at
// maxPasses, leave matched=false, and report exactly what's still wrong —
// this is the "[ALERT]" condition surfaced to the user.
test('verification loop gives up after maxPasses and reports the remaining gap', async () => {
  const boxes: WorkOrderBox[] = [
    { selector: '#box-1', serialNum: 'A', partNums: ['M23'] }, // never gets RC
    { selector: '#box-3', serialNum: 'C', partNums: ['R28L'] },
    // B never appears
  ];

  const ladderResults = startingResults();
  const outcome = await runVerificationLoop(records, ladderResults, new Set(), {
    wait: noWait,
    maxPasses: 3,
    scrapeBoxes: async () => boxes,
    fixGaps: async () => [], // fixes never actually land
  });

  assert.equal(outcome.verification.passes, 3);
  assert.equal(outcome.verification.fixAttempts, 2);
  assert.equal(outcome.verification.matched, false);
  assert.deepEqual(outcome.verification.missingBoxes, ['B']);
  assert.deepEqual(outcome.verification.missingParts, [{ serialNum: 'A', parts: ['RC'] }]);
});
