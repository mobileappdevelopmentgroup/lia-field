import { parseCsv } from './csv-parser.js';
import { launchBrowser, findWorkOrderPage, runAutomation } from './automation.js';
import { buildSummary, printSummary, writeJsonLog } from './reporter.js';
import type { LadderRecord, LadderResult, RunSummary, AutomationOptions } from './types.js';

const AUTOMATION_OPTS: AutomationOptions = {
  dropdownTimeout: 15_000,
  pauseBetweenLadders: 2_000,
  actionDelay: 1_200,
  serialApiDelay: 3_000,
};

export interface RunResult {
  success: boolean;
  summary?: RunSummary;
  logPath?: string;
  error?: string;
}

export async function run(
  csvPath: string,
  waitForReady: () => Promise<void>,
  logsDir?: string,
): Promise<RunResult> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       BATAVIA LADDER AUTOMATION                  ║');
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
  console.log('Work order popup detected!');
  console.log('Navigate to the correct work order, then click "Begin Automation".');
  console.log('──────────────────────────────────────────────────\n');

  await waitForReady();

  await new Promise((r) => setTimeout(r, 2000));
  console.log('\nStarting automation...\n');

  const startTime = Date.now();
  let ladderResults: LadderResult[];
  try {
    ladderResults = await runAutomation(records, workPage, AUTOMATION_OPTS);
  } catch (err: unknown) {
    await browser.close();
    return { success: false, error: `FATAL ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }

  const durationMs = Date.now() - startTime;
  const summary = buildSummary(ladderResults, durationMs);
  printSummary(summary);

  const logPath = writeJsonLog(summary, logsDir);
  console.log(`\nDetailed log: ${logPath}\n`);

  return { success: true, summary, logPath };
}
