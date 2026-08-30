import type { Page } from 'playwright';
import {
  buildFpBoxRecords, diffFpAgainstWorkOrder, groupByWorkOrder,
  type FpInspectionForBsi, type FpBoxRecord,
} from './core/fp-bsi.js';

// Putting fall-protection work onto a BSI work order.
//
// ── The preflight, and why it refuses ───────────────────────────────────────
// The ladder importer was written against a form somebody had in front of them.
// This one was not: BSI's fall-protection flow has not been confirmed field by
// field. The tempting thing is to assume it matches the ladder form and let it
// run — and the failure mode of that assumption is boxes full of wrong values
// on a live customer work order, discovered at invoicing.
//
// So every selector this needs is declared once, below, and checked against the
// real page before anything is typed. If the form does not look the way this
// expects, the run STOPS and names exactly which controls are missing. A run
// that refuses costs an afternoon; a run that silently mis-fills forty boxes
// costs a customer relationship.
//
// When the FP form is confirmed, correct FP_FORM and delete nothing else.

export interface FpFormSpec {
  /** Selector, and what it is for, so a failure report is readable. */
  serial: string;
  description: string;
  addBox: string;
  /** Optional — absent on the ladder form, may exist on the FP one. */
  manufacturer?: string;
  model?: string;
}

// Declared in ONE place. Everything else in this file reads from it.
export const FP_FORM: FpFormSpec = {
  serial: '#WoSerialNumber',
  description: '#WoLadDesc',
  addBox: 'button:has-text("Add Box")',
  manufacturer: '#LadderBrand',
  model: undefined,
};

export interface PreflightReport {
  ok: boolean;
  missing: string[];
  found: string[];
  message: string;
}

/**
 * Checks the page carries the controls this importer intends to drive.
 * Called before ANY value is entered.
 */
export async function fpPreflight(page: Page, spec: FpFormSpec = FP_FORM): Promise<PreflightReport> {
  const required: Array<[string, string]> = [
    ['serial number', spec.serial],
    ['description', spec.description],
    ['Add Box button', spec.addBox],
  ];

  const missing: string[] = [];
  const found: string[] = [];

  for (const [name, sel] of required) {
    // count() rather than isVisible(): a field inside a collapsed section is
    // present and drivable, and demanding visibility would refuse a form that
    // is actually fine.
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) found.push(`${name} (${sel})`);
    else missing.push(`${name} (${sel})`);
  }

  const ok = missing.length === 0;
  return {
    ok,
    missing,
    found,
    message: ok
      ? 'The work order form matches what the importer expects.'
      : 'This work order does not have the fields the fall-protection importer ' +
        'expects, so nothing was entered. Missing: ' + missing.join(', ') +
        '. Confirm the BSI fall-protection form and update FP_FORM in ' +
        'src/fp-automation.ts before running this again.',
  };
}

/**
 * Serials already on the work order, so a re-run adds only what is missing.
 *
 * Always an array, whatever the page gives back. If this returned something
 * else the diff would throw BEFORE the loop starts, killing a run that would
 * otherwise have worked — and a page that has been navigated away, or is
 * mid-reload, is exactly when that happens. An empty list is the safe answer:
 * the per-item dedupe in fp-bsi still catches repeats within the run.
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
  preflight: PreflightReport;
}

export interface FpPushOptions {
  actionDelay?: number;
  /** Called per item so the UI can show progress on a long run. */
  onProgress?: (done: number, total: number, serial: string) => void;
  /**
   * Called the moment a box actually lands, BEFORE the next one is attempted.
   *
   * This is where the fault tolerance lives. BSI drops connections, hangs on a
   * save, and occasionally kills the popup outright. If "what landed" were only
   * reported at the end of the run, a crash at item 20 of 40 would leave the
   * database believing none of the 20 went in — and the re-run would add them a
   * second time, billing the customer twice. Reporting per box means a re-run
   * starts from 21.
   */
  onPushed?: (rec: { inspectionId: string; serialNum: string; boxRef: string }) => void;
}

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Pushes one work order's fall-protection items.
 *
 * Never re-adds. Never continues past a failed preflight. A per-item failure is
 * recorded and the run carries on, because one bad serial should not strand the
 * other thirty — that is the same rule the ladder importer follows.
 */
export async function pushFpToWorkOrder(
  page: Page,
  items: FpInspectionForBsi[],
  opts: FpPushOptions = {},
): Promise<FpPushResult> {
  const delay = opts.actionDelay ?? 1_200;
  const { records, skipped } = buildFpBoxRecords(items);
  const preflight = await fpPreflight(page);

  if (!preflight.ok) {
    return { pushed: [], skipped, failed: [], preflight };
  }

  // Re-adding is what double-bills a customer, so what is already there is
  // established before anything is typed.
  const existing = await scrapeFpSerials(page);
  const { toAdd, alreadyThere } = diffFpAgainstWorkOrder(records, existing);

  for (const r of alreadyThere) {
    skipped.push({ inspection_id: r.inspectionId, serial_num: r.serialNum,
                   reason: 'Already on this work order' });
  }

  const pushed: FpPushResult['pushed'] = [];
  const failed: FpPushResult['failed'] = [];
  let done = 0;

  for (const rec of toAdd) {
    opts.onProgress?.(done, toAdd.length, rec.serialNum);
    try {
      await page.fill(FP_FORM.serial, rec.serialNum);
      await pause(delay);

      // BSI's selects are driven by jQuery handlers that a native Playwright
      // selectOption bypasses entirely — the value changes and nothing reacts.
      // Both events have to be fired by hand. Same quirk as the ladder form;
      // see keyboardSelectDropdown() in automation.ts.
      await page.evaluate(({ sel, value }) => {
        const el = document.querySelector(sel) as HTMLSelectElement | HTMLInputElement | null;
        if (!el) return;
        (el as HTMLInputElement).value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const w = window as unknown as { $?: (e: Element) => { trigger: (n: string) => void } };
        if (w.$) w.$(el).trigger('change');
      }, { sel: FP_FORM.description, value: rec.desc });
      await pause(delay);

      await page.click(FP_FORM.addBox);
      await pause(delay * 2);

      const boxRef = await latestBoxRef(page);
      const landed = { inspectionId: rec.inspectionId, serialNum: rec.serialNum, boxRef };
      pushed.push(landed);
      // Recorded now, not at the end — see onPushed above.
      opts.onPushed?.(landed);
    } catch (err) {
      // One bad serial must not strand the other thirty.
      failed.push({
        inspectionId: rec.inspectionId,
        serialNum: rec.serialNum,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    done++;
  }

  opts.onProgress?.(done, toAdd.length, '');
  return { pushed, skipped, failed, preflight };
}

async function latestBoxRef(page: Page): Promise<string> {
  return page.evaluate(() => {
    const nums = [...document.querySelectorAll('[id^="box-"]')]
      .map(el => Number(el.id.replace('box-', '')))
      .filter(n => Number.isFinite(n));
    return nums.length ? 'box-' + Math.max(...nums) : '';
  }).catch(() => '');
}

export { groupByWorkOrder };
