import { diffCsvVsWorkOrder } from './automation.js';
import type {
  LadderRecord,
  LadderResult,
  WorkOrderBox,
  DiffResult,
  VerificationReport,
} from './types.js';

export const MAX_VERIFY_PASSES = 5; // post-import CSV vs work-order checks (fixes run between passes)

export interface VerifyDeps {
  /** Re-read the current state of the work order. */
  scrapeBoxes: () => Promise<WorkOrderBox[]>;
  /** Re-import whatever is still missing. Returns results for the items it touched. */
  fixGaps: (gaps: Pick<DiffResult, 'missingBoxes' | 'existingWithGaps'>) => Promise<LadderResult[]>;
  /** Delay before re-scraping, so the page can settle. Defaults to a real timer. */
  wait?: (ms: number) => Promise<void>;
  maxPasses?: number;
}

export interface VerificationOutcome {
  verification: VerificationReport;
  finalBoxes: WorkOrderBox[];
}

// Fold retry results from a verification fix pass into the original results.
// A retry entry only replaces the original when it actually improved things,
// so a ladder that imported cleanly the first time is never downgraded.
export function mergeLadderResults(base: LadderResult[], retry: LadderResult[]): void {
  for (const r of retry) {
    const idx = base.findIndex((b) => b.serialNum === r.serialNum);
    if (idx === -1) {
      base.push(r);
    } else if (r.partsOk > base[idx]!.partsOk || (base[idx]!.status !== 'success' && r.status === 'success')) {
      base[idx] = r;
    }
  }
}

// Re-scrape the work order and compare every CSV line against it. Anything
// missing is re-imported via deps.fixGaps, then checked again — up to
// deps.maxPasses checks (default MAX_VERIFY_PASSES). Mutates `ladderResults`
// in place with any successful fixes.
export async function runVerificationLoop(
  records: LadderRecord[],
  ladderResults: LadderResult[],
  intentionalSerials: Set<string>,
  deps: VerifyDeps,
): Promise<VerificationOutcome> {
  const maxPasses = deps.maxPasses ?? MAX_VERIFY_PASSES;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const verification: VerificationReport = {
    passes: 0, fixAttempts: 0, matched: false, missingBoxes: [], missingParts: [],
  };
  let finalBoxes: WorkOrderBox[] = [];

  for (let pass = 1; pass <= maxPasses; pass++) {
    verification.passes = pass;
    console.log(`\n[VERIFY ${pass}/${maxPasses}] Comparing work order against CSV...`);
    await wait(1500); // let page settle

    try {
      finalBoxes = await deps.scrapeBoxes();
    } catch (err: unknown) {
      console.error(`  Could not re-read the work order: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    const vdiff = diffCsvVsWorkOrder(records, finalBoxes);
    const fixableGaps = vdiff.existingWithGaps.filter((g) => !intentionalSerials.has(g.record.serialNum));
    const skippedGaps = vdiff.existingWithGaps.filter((g) => intentionalSerials.has(g.record.serialNum));

    verification.missingBoxes = vdiff.missingBoxes.map((r) => r.serialNum);
    verification.missingParts = fixableGaps.map((g) => ({
      serialNum: g.record.serialNum,
      parts: g.missingParts.map((p) => p.searchTerm),
    }));
    if (skippedGaps.length > 0) {
      verification.intentionallySkipped = skippedGaps.map((g) => ({
        serialNum: g.record.serialNum,
        parts: g.missingParts.map((p) => p.searchTerm),
      }));
    } else {
      delete verification.intentionallySkipped;
    }

    if (vdiff.missingBoxes.length === 0 && fixableGaps.length === 0) {
      verification.matched = true;
      console.log('  ✓ Verified — every CSV line matches the work order.');
      break;
    }

    console.log(`  [MISMATCH] ${vdiff.missingBoxes.length} ladder(s) missing, ${fixableGaps.length} box(es) with missing parts:`);
    for (const r of vdiff.missingBoxes) console.log(`    ✗ SN ${r.serialNum}: not on work order`);
    for (const g of fixableGaps) console.log(`    ⚠ SN ${g.record.serialNum}: missing ${g.missingParts.map((p) => p.searchTerm).join(', ')}`);

    if (pass === maxPasses) {
      console.error(`  [ALERT] Still mismatched after ${maxPasses} verification passes — review the summary and fix manually.`);
      break;
    }

    verification.fixAttempts++;
    console.log(`  Re-importing the missing items (fix attempt ${verification.fixAttempts})...`);
    try {
      const retryResults = await deps.fixGaps({ missingBoxes: vdiff.missingBoxes, existingWithGaps: fixableGaps });
      mergeLadderResults(ladderResults, retryResults);
    } catch (err: unknown) {
      console.error(`  Fix attempt failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { verification, finalBoxes };
}
