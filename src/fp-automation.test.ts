import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fpPreflight, pushFpToWorkOrder, FP_FORM } from './fp-automation.js';

// The preflight exists because BSI's fall-protection form has not been
// confirmed field by field. Every test here is about what happens when the page
// is not the one this code was written for — because the alternative to
// refusing is forty boxes of wrong values on a live customer work order.

/** A stand-in page: says which selectors exist, records everything typed. */
function fakePage(present: string[], opts: { throwOn?: string; existing?: string[] } = {}) {
  const typed: Array<[string, string]> = [];
  const clicked: string[] = [];
  return {
    typed, clicked,
    locator: (sel: string) => ({ count: async () => (present.includes(sel) ? 1 : 0) }),
    fill: async (sel: string, value: string) => {
      if (opts.throwOn && value === opts.throwOn) throw new Error('BSI dropped the connection');
      typed.push([sel, value]);
    },
    click: async (sel: string) => { clicked.push(sel); },
    evaluate: async (fn: unknown, arg?: unknown) => {
      // Three call sites, told apart by what the page function actually asks
      // for rather than by call order — order changes, intent does not.
      if (arg && typeof arg === 'object' && 'sel' in (arg as object)) {
        const a = arg as { sel: string; value: string };
        typed.push([a.sel, a.value]);
        return undefined;
      }
      const src = String(fn);
      if (src.includes('boxserialnumberh-')) return opts.existing ?? [];
      return 'box-1';
    },
  } as never;
}

const ALL = [FP_FORM.serial, FP_FORM.description, FP_FORM.addBox];

test('a page carrying the expected controls passes the preflight', async () => {
  const r = await fpPreflight(fakePage(ALL));
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test('a missing control fails the preflight and is NAMED', async () => {
  const r = await fpPreflight(fakePage([FP_FORM.serial]));
  assert.equal(r.ok, false);
  // "Something went wrong" sends somebody hunting; the selector does not.
  assert.match(r.message, /description/);
  assert.match(r.message, /Add Box/);
  assert.match(r.message, /FP_FORM/);
});

test('a failed preflight means NOTHING is typed on the page', async () => {
  const page = fakePage([]) as unknown as { typed: string[][]; clicked: string[] };
  const res = await pushFpToWorkOrder(page as never, [
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
  ]);
  assert.equal(res.preflight.ok, false);
  assert.equal(res.pushed.length, 0);
  assert.deepEqual(page.typed, []);
  assert.deepEqual(page.clicked, []);
});

test('a good page gets the serial and the description, and one Add Box', async () => {
  const page = fakePage(ALL) as unknown as { typed: string[][]; clicked: string[] };
  const res = await pushFpToWorkOrder(page as never, [
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
  ], { actionDelay: 0 });
  assert.equal(res.pushed.length, 1);
  assert.equal(res.pushed[0].boxRef, 'box-1');
  assert.deepEqual(page.typed, [[FP_FORM.serial, 'H-1'],
                                [FP_FORM.description, 'Fall Protection Inspection']]);
  assert.equal(page.clicked.length, 1);
});

// Re-adding is what double-bills a customer, and BSI runs die halfway often
// enough that re-running is normal rather than exceptional.
test('a serial already on the work order is skipped, not added again', async () => {
  // Matched loosely, the way BSI matches: 'h 1' on the page is 'H-1' here.
  const page = fakePage(ALL, { existing: ['h 1'] }) as unknown as { typed: string[][] };
  const res = await pushFpToWorkOrder(page as never, [
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
    { inspection_id: 'i2', work_order_id: 'WO-1', serial_num: 'H-2' },
  ], { actionDelay: 0 });
  assert.deepEqual(res.pushed.map(r => r.serialNum), ['H-2']);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /Already on this work order/);
  // And it was never typed — the skip is real, not cosmetic.
  assert.equal(page.typed.some(t => t[1] === 'H-1'), false);
});

// A page that has been navigated away mid-run answers nonsense. That used to
// throw before the loop even started, killing a run that was otherwise fine.
test('a page that cannot say what is on it does not kill the run', async () => {
  const page = fakePage(ALL, { existing: undefined });
  const broken = { ...(page as object), evaluate: async (fn: unknown, arg?: unknown) => {
    if (arg && typeof arg === 'object' && 'sel' in (arg as object)) return undefined;
    if (String(fn).includes('boxserialnumberh-')) return null;  // not an array
    return 'box-1';
  } };
  const res = await pushFpToWorkOrder(broken as never, [
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
  ], { actionDelay: 0 });
  assert.equal(res.pushed.length, 1);
});

test('one bad serial does not strand the rest of the run', async () => {
  const page = fakePage(ALL, { throwOn: 'H-2' }) as unknown as { typed: string[][] };
  const res = await pushFpToWorkOrder(page as never, [
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
    { inspection_id: 'i2', work_order_id: 'WO-1', serial_num: 'H-2' },
    { inspection_id: 'i3', work_order_id: 'WO-1', serial_num: 'H-3' },
  ], { actionDelay: 0 });
  assert.deepEqual(res.pushed.map(r => r.serialNum), ['H-1', 'H-3']);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /dropped the connection/);
});

// The whole fault-tolerance story: what landed is known before the next attempt,
// so a crash cannot leave the database believing nothing went in.
test('each landed box is reported before the next one is attempted', async () => {
  const page = fakePage(ALL, { throwOn: 'H-2' });
  const order: string[] = [];
  await pushFpToWorkOrder(page, [
    { inspection_id: 'i1', work_order_id: 'WO-1', serial_num: 'H-1' },
    { inspection_id: 'i2', work_order_id: 'WO-1', serial_num: 'H-2' },
  ], {
    actionDelay: 0,
    onPushed: r => order.push('landed:' + r.serialNum),
    onProgress: (_d, _t, s) => { if (s) order.push('start:' + s); },
  });
  assert.deepEqual(order, ['start:H-1', 'landed:H-1', 'start:H-2']);
});
