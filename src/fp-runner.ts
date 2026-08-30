import { launchBrowser, findWorkOrderPage } from './automation.js';
import { fpPreflight, pushFpToWorkOrder, type FpPushResult } from './fp-automation.js';
import { groupByWorkOrder, buildFpBoxRecords, type FpInspectionForBsi } from './core/fp-bsi.js';

// Driving fall-protection work onto BSI, one work order at a time.
//
// This mirrors src/runner.ts rather than reusing it, because the two flows only
// look alike: the ladder run reads a CSV the tech chose and imports everything
// in it, while this one takes records that are already in our database and has
// to stay reconciled with them. The shared part — launching Chrome and finding
// the work-order popup — is imported, not copied.
//
// ── Fault tolerance ────────────────────────────────────────────────────────
// BSI is flaky. Three things follow from that, and all three are load-bearing:
//
//   1. Nothing is typed until the preflight confirms the form is the one this
//      code was written for (see fp-automation.ts).
//   2. Every box that lands is reported IMMEDIATELY, so a crash halfway through
//      leaves the database knowing exactly what went in. A re-run then adds
//      only the remainder instead of billing the customer twice.
//   3. A per-item failure is recorded and the run continues. One bad serial
//      must not strand the other thirty.

export interface FpRunResult {
  success: boolean;
  error?: string;
  workOrders?: Array<{
    workOrderId: string;
    pushed: FpPushResult['pushed'];
    skipped: FpPushResult['skipped'];
    failed: FpPushResult['failed'];
    preflight: FpPushResult['preflight'];
  }>;
  totals?: { pushed: number; skipped: number; failed: number };
}

export interface FpRunCallbacks {
  /** Resolves when the operator says the right work order is open. */
  waitForReady: () => Promise<void>;
  /** Called per landed box so the parent can persist it right away. */
  onPushed: (rec: { inspectionId: string; serialNum: string; boxRef: string }) => void;
}

export async function runFpPush(
  items: FpInspectionForBsi[],
  callbacks: FpRunCallbacks,
): Promise<FpRunResult> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   LIA — Fall Protection → BSI                    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!items || items.length === 0) {
    return { success: false, error: 'Nothing to push — no unpushed fall protection records.' };
  }

  // Built here as well as inside pushFpToWorkOrder so the operator is told what
  // is going where before Chrome opens, rather than after.
  const { records, skipped: unpushable } = buildFpBoxRecords(items);
  const groups = groupByWorkOrder(records);

  console.log(`${items.length} record(s) → ${records.length} box(es) across ${groups.size} work order(s).`);
  if (unpushable.length) {
    console.log('\nNot pushed:');
    for (const s of unpushable) console.log(`  ${s.serial_num || '(no serial)'}: ${s.reason}`);
  }
  if (groups.size === 0) {
    return { success: false, error: 'None of these records can be pushed. See the list above.' };
  }

  console.log('\nOpening browser — log in and open the work order popup...\n');
  const { browser, context, mainPage } = await launchBrowser();

  const out: FpRunResult['workOrders'] = [];
  const totals = { pushed: 0, skipped: unpushable.length, failed: 0 };

  try {
    for (const [workOrderId, recs] of groups) {
      console.log('\n──────────────────────────────────────────────────');
      console.log(`WORK ORDER ${workOrderId} — ${recs.length} item(s)`);
      console.log('Open this work order in BSI, then click Continue.');
      console.log('──────────────────────────────────────────────────\n');

      // Each work order is confirmed by a human before anything is typed. There
      // is no way for this code to verify from the page which work order is
      // open, and pushing forty boxes onto the wrong one is not recoverable by
      // a re-run — it has to be undone by hand, box by box.
      await callbacks.waitForReady();

      const workPage = await waitForPopup(context, mainPage);
      if (!workPage) {
        out.push({ workOrderId, pushed: [], skipped: [], failed: [],
          preflight: { ok: false, missing: [], found: [],
            message: 'No BSI work order window was open, so nothing was entered.' } });
        continue;
      }

      const forThisWo = items.filter(i => String(i.work_order_id ?? '') === workOrderId);
      const res = await pushFpToWorkOrder(workPage, forThisWo, {
        onPushed: callbacks.onPushed,
        onProgress: (done, total, serial) => {
          if (serial) console.log(`  [${done + 1}/${total}] ${serial}`);
        },
      });

      if (!res.preflight.ok) {
        // Refused, deliberately. Reported and moved on rather than throwing, so
        // a second work order in the same run still gets its chance.
        console.log('\n' + res.preflight.message + '\n');
      }

      totals.pushed += res.pushed.length;
      totals.skipped += res.skipped.length;
      totals.failed += res.failed.length;
      out.push({ workOrderId, ...res });

      console.log(`\n${workOrderId}: ${res.pushed.length} added, ` +
                  `${res.skipped.length} skipped, ${res.failed.length} failed.`);
    }
  } catch (err: unknown) {
    // Whatever landed before this point has already been reported through
    // onPushed, so the run is salvageable even though it ended badly.
    await browser.close().catch(() => {});
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      workOrders: out,
      totals,
    };
  }

  await browser.close().catch(() => {});

  const anyRefused = out.some(w => !w.preflight.ok);
  return { success: totals.pushed > 0 && !anyRefused, workOrders: out, totals };
}

/** Finds the BSI popup, waiting up to five minutes for the operator to open it. */
async function waitForPopup(
  context: import('playwright').BrowserContext,
  mainPage: import('playwright').Page,
): Promise<import('playwright').Page | null> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const page = await findWorkOrderPage(context, mainPage);
      // A popup that has been closed still shows up in context.pages() briefly.
      if (!page.isClosed()) return page;
    } catch { /* not open yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

export { fpPreflight };
