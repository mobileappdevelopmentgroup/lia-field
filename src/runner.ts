import { parseCsv } from './csv-parser.js';
import {
  launchBrowser,
  findWorkOrderPage,
  runAutomation,
  scrapeWorkOrderBoxes,
  diffCsvVsWorkOrder,
  runAutomationWithDiff,
} from './automation.js';
import { buildSummary, printSummary, writeJsonLog } from './reporter.js';
import type { LadderRecord, LadderResult, RunSummary, AutomationOptions, DiffResult, DiffChoice } from './types.js';

const AUTOMATION_OPTS: AutomationOptions = {
  dropdownTimeout: 15_000,
  pauseBetweenLadders: 4_000,
  actionDelay: 1_200,
  serialApiDelay: 3_500,
};

export interface RunResult {
  success: boolean;
  summary?: RunSummary;
  logPath?: string;
  error?: string;
}

export interface RunCallbacks {
  /** Called after popup detected — user should navigate to correct work order, then resolve. */
  waitForAnalyzeReady: () => Promise<void>;
  /** Called after scraping — shows diff to user and waits for their mode choice. */
  waitForDiffChoice: (diff: DiffResult) => Promise<DiffChoice>;
}

export async function run(
  csvPath: string,
  callbacks: RunCallbacks,
  logsDir?: string,
): Promise<RunResult> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       LIA — Ladder Import Assistant              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log(`Loading CSV: ${csvPath}\n`);

  let records: LadderRecord[];
  let skipped: Array<{ row: number; serialNum: string; reason: string }>;
  try {
    ({ records, skipped } = parseCsv(csvPath));
  } catch (err: unknown) {
    return { success: false, error: `${err instanceof Error ? err.message : String(err)}` };
  }

  if (records.length === 0) {
    return { success: false, error: 'No valid rows found. Every row needs a "Serial #" column with a value.' };
  }

  const totalParts = records.reduce((s, r) => s + r.parts.length, 0);
  console.log(`Found ${records.length} ladder(s) — ${totalParts} total part(s) to add.`);

  if (skipped.length > 0) {
    console.log('\nSkipped rows (missing SerialNum):');
    skipped.forEach((s) => console.log(`  Row ${s.row}: ${s.reason}`));
  }

  console.log('\nOpening browser — log in and open the work order popup...\n');
  const { browser, context, mainPage } = await launchBrowser();

  console.log('──────────────────────────────────────────────────');
  console.log('DO THIS IN THE BROWSER WINDOW:');
  console.log('  1. Log in with your username and password.');
  console.log('  2. Click Work Orders → Work Orders List.');
  console.log('  3. Click the VIEW button on your work order.');
  console.log('──────────────────────────────────────────────────');
  console.log('\nWaiting for work order popup (up to 5 minutes)...\n');

  let workPage: import('playwright').Page | null = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    try {
      workPage = await findWorkOrderPage(context, mainPage);
      console.log(`\nPopup detected: ${workPage.url()}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      tick++;
      if (tick % 15 === 0) {
        const urls = context.pages().map((p) => p.url());
        console.log(`  [${Math.round((deadline - Date.now()) / 1000)}s left] Open pages: ${urls.join(' | ')}`);
      } else {
        process.stdout.write('.');
      }
    }
  }

  if (!workPage) {
    await browser.close();
    return { success: false, error: 'Timed out. Make sure you clicked View on the work order.' };
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log('Navigate to the correct work order, then click "Analyze Work Order".');
  console.log('──────────────────────────────────────────────────\n');

  await callbacks.waitForAnalyzeReady();

  // Scrape existing boxes and compute diff
  console.log('\nAnalyzing work order...');
  await new Promise((r) => setTimeout(r, 1500)); // let page settle
  const existingBoxes = await scrapeWorkOrderBoxes(workPage);
  console.log(`  Found ${existingBoxes.length} existing box(es) on work order.`);

  const diff = diffCsvVsWorkOrder(records, existingBoxes);
  console.log(`  CSV: ${records.length} ladders | Missing: ${diff.missingBoxes.length} | Existing with gaps: ${diff.existingWithGaps.length} | Complete: ${diff.alreadyComplete.length}`);

  const choice = await callbacks.waitForDiffChoice(diff);

  if (choice === 'cancel') {
    console.log('\nCancelled by user.');
    await browser.close();
    return { success: false, error: 'Cancelled by user.' };
  }

  await new Promise((r) => setTimeout(r, 1000));
  console.log(`\nStarting import (mode: ${choice})...\n`);

  const startTime = Date.now();
  let ladderResults: LadderResult[];
  try {
    if (existingBoxes.length === 0) {
      // Fresh work order — use standard flow (slightly faster, no diff overhead)
      ladderResults = await runAutomation(records, workPage, AUTOMATION_OPTS);
    } else {
      ladderResults = await runAutomationWithDiff(diff, choice, workPage, AUTOMATION_OPTS);
    }
  } catch (err: unknown) {
    await browser.close();
    return { success: false, error: `FATAL ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }

  const durationMs = Date.now() - startTime;
  const summary = buildSummary(ladderResults, durationMs);

  // Compare final work-order state vs CSV — flag any parts in BSI not present in CSV.
  try {
    const finalBoxes = await scrapeWorkOrderBoxes(workPage);
    const csvPartsBySerial = new Map(records.map(r => [
      r.serialNum,
      new Set(r.parts.map(p => p.searchTerm.toUpperCase())),
    ]));
    const extra: import('./types.js').ExtraPartEntry[] = [];
    for (const box of finalBoxes) {
      const csvParts = csvPartsBySerial.get(box.serialNum);
      for (const p of box.partNums) {
        const pu = p.toUpperCase();
        // "extra" = in BSI but not matched by any CSV search term
        const inCsv = csvParts
          ? [...csvParts].some(t => t === pu || pu.includes(t) || t.includes(pu))
          : false;
        if (!inCsv) extra.push({ boxSerial: box.serialNum, partNum: p });
      }
    }
    if (extra.length > 0) {
      console.log(`\n[EXTRA] ${extra.length} part(s) on work order not in CSV:`);
      for (const e of extra) console.log(`  SN ${e.boxSerial}: ${e.partNum}`);
      summary.extraOnWorkOrder = extra;
    }
  } catch { /* non-fatal */ }

  printSummary(summary);
  const logPath = writeJsonLog(summary, logsDir);
  console.log(`\nDetailed log: ${logPath}\n`);

  return { success: true, summary, logPath };
}
