import type { Page } from 'playwright';
import {
  buildFpBoxRecords, diffFpAgainstWorkOrder, fpBoxAsLadderRecord, groupByWorkOrder,
  type FpInspectionForBsi, type FpBoxRecord,
} from './core/fp-bsi.js';
import { runAutomation } from './automation.js';
import type { AutomationOptions, LadderRecord } from './types.js';

// Putting fall-protection work onto a BSI work order.
//
// ── What this file used to be ───────────────────────────────────────────────
// A parallel importer with its own form mapping (`FP_FORM`) and a preflight
// that refused to run, because BSI's fall-protection flow had never been
// confirmed field by field and filling forty boxes with guessed values on a
// live customer work order was the failure to avoid.
//
// Work order 98471, read on 2026-09-21, showed the guess was not merely
// unconfirmed but unnecessary: **fall protection is the ladder form.** One box
// for the whole work order, the items collapsed onto it as parts by equipment
// type. There is no second form, so there is no second importer, so there is
// nothing for a preflight to refuse.
//
// What is left here is a translation and a call. The box goes through
// runAutomation() — the same path that has been putting ladders on real work
// orders for months, with its diff, its retries, its per-part dedupe and its
// verification pass — rather than a parallel path with none of that history.
//
// See docs/BSI-FORM.md for the form itself and src/core/fp-bsi.ts for the
// mapping, which is pure and unit-tested away from Playwright.

/**
 * Serials already on the work order, so a re-run adds nothing twice.
 *
 * Always an array, whatever the page gives back. If this returned something
 * else the diff would throw BEFORE the run starts, killing a run that would
 * otherwise have worked — and a page mid-reload is exactly when that happens.
 * An empty list is the safe answer: the box serial is derived from the work
 * order, so the ladder importer's own box diff still catches a repeat.
 */
export async function scrapeFpSerials(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('[id^="boxserialnumberh-"]').forEach(el => {
      const v = (el as HTMLInputElement).value;
      if (v) out.push(v);
    });
    return out;
  }).catch(() => []);
  return Array.isArray(raw) ? raw.filter(v => typeof v === 'string') : [];
}

export interface FpPushResult {
  pushed: Array<{ inspectionId: string; serialNum: string; boxRef: string }>;
  skipped: Array<{ inspection_id: string; serial_num: string; reason: string }>;
  failed: Array<{ inspectionId: string; serialNum: string; error: string }>;
  /** What was billed, by code — the operator sees this before and after. */
  lines: Array<{ code: string; description: string; quantity: number }>;
}

export interface FpPushOptions {
  actionDelay?: number;
  onProgress?: (done: number, total: number, serial: string) => void;
  /**
   * Called the moment the box lands, BEFORE anything else is attempted.
   *
   * BSI drops connections and hangs on a save. If "what landed" were reported
   * only at the end, a crash mid-run would leave the database believing
   * nothing went in — and the re-run would bill the customer a second time.
   */
  onPushed?: (rec: { inspectionId: string; serialNum: string; boxRef: string }) => void;
}

/**
 * Pushes one work order's fall-protection items as a single box.
 *
 * Never re-adds: the box serial is `1111` + the work order, so a second run
 * recognises its own box. Items that cannot be billed — an equipment type with
 * no code — come back in `skipped` with a reason and are never guessed at.
 */
export async function pushFpToWorkOrder(
  page: Page,
  items: FpInspectionForBsi[],
  opts: FpPushOptions = {},
): Promise<FpPushResult> {
  const { records, skipped, lines } = buildFpBoxRecords(items);

  if (!records.length) {
    return { pushed: [], skipped, failed: [], lines };
  }

  // Establish what is already there before anything is typed: re-adding the
  // box is what would bill the customer twice.
  const existing = await scrapeFpSerials(page);
  const { toAdd, alreadyThere } = diffFpAgainstWorkOrder(records, existing);

  for (const r of alreadyThere) {
    skipped.push({
      inspection_id: r.inspectionIds.join(','),
      serial_num: r.serialNum,
      reason: 'This work order already has its fall protection box',
    });
  }
  if (!toAdd.length) return { pushed: [], skipped, failed: [], lines };

  const pushed: FpPushResult['pushed'] = [];
  const failed: FpPushResult['failed'] = [];

  for (const rec of toAdd) {
    opts.onProgress?.(0, 1, rec.serialNum);
    try {
      const ladder = fpBoxAsLadderRecord(rec) as LadderRecord;
      const automationOpts: AutomationOptions = {
        actionDelay: opts.actionDelay ?? 1_200,
        pauseBetweenLadders: opts.actionDelay ?? 1_200,
      } as AutomationOptions;

      const [result] = await runAutomation([ladder], page, automationOpts);
      if (!result || result.status === 'error') {
        throw new Error(result?.errorMsg || 'BSI would not take the box');
      }

      const boxRef = await latestBoxRef(page);
      // Every inspection on the box is marked, not just one: they were all
      // billed by it, and a crash before the next step must not leave half of
      // them looking unbilled.
      for (const id of rec.inspectionIds) {
        const landed = { inspectionId: id, serialNum: rec.serialNum, boxRef };
        pushed.push(landed);
        opts.onPushed?.(landed);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const id of rec.inspectionIds) {
        failed.push({ inspectionId: id, serialNum: rec.serialNum, error: message });
      }
    }
  }

  opts.onProgress?.(1, 1, '');
  return { pushed, skipped, failed, lines };
}

async function latestBoxRef(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nums = [...document.querySelectorAll('[id^="box-"]')]
      .map(el => Number(el.id.replace('box-', '')))
      .filter(n => Number.isFinite(n));
    return nums.length ? 'box-' + Math.max(...nums) : '';
  }).catch(() => '');
}

export { groupByWorkOrder, diffFpAgainstWorkOrder, type FpBoxRecord };
