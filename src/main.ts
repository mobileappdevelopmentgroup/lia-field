import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { parseCsv } from './csv-parser.js';
import { launchBrowser, findWorkOrderPage, runAutomation } from './automation.js';
import { buildSummary, printSummary, writeJsonLog } from './reporter.js';
import type { AutomationOptions } from './types.js';

const CSV_DIR = path.join(process.cwd(), 'Ladders - Add your csv file here');

const AUTOMATION_OPTS: AutomationOptions = {
  dropdownTimeout: 15_000,      // 15s for slow BSI API
  pauseBetweenLadders: 2_000,
  actionDelay: 1_200,           // 1.2s after every click/fill/select
  serialApiDelay: 3_000,        // minimum wait after serial confirmation before reading fields
};

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getCsvPath(): string {
  const flag = process.argv.indexOf('--csv');
  if (flag !== -1 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1]);
  // Pick the first .csv found in the drop folder, regardless of filename
  if (fs.existsSync(CSV_DIR)) {
    const files = fs.readdirSync(CSV_DIR)
      .filter((f) => f.toLowerCase().endsWith('.csv') && !f.startsWith('.'));
    if (files.length > 0) return path.join(CSV_DIR, files[0]);
  }
  return path.join(CSV_DIR, 'ladders.csv'); // fallback path for the error message
}

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       BATAVIA LADDER AUTOMATION                  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const csvPath = getCsvPath();
  console.log(`Loading CSV: ${csvPath}\n`);

  let records, skipped;
  try {
    ({ records, skipped } = parseCsv(csvPath));
  } catch (err: unknown) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\nDrop your CSV into:\n  ${CSV_DIR}`);
    console.error('Or pass a custom path:  --csv /path/to/file.csv\n');
    process.exit(1);
  }

  if (records.length === 0) {
    console.error('No valid rows found. Every row needs a "Serial #" column with a value.');
    process.exit(1);
  }

  const totalParts = records.reduce((s, r) => s + r.parts.length, 0);
  console.log(`Found ${records.length} ladder(s) — ${totalParts} total part(s) to add.`);

  if (skipped.length > 0) {
    console.log('\nSkipped rows (missing SerialNum):');
    skipped.forEach((s) => console.log(`  Row ${s.row}: ${s.reason}`));
  }

  // Launch Playwright's browser and open the login page
  console.log('\nOpening browser — log in and open the work order popup...\n');
  const { browser, context, mainPage } = await launchBrowser();

  console.log('──────────────────────────────────────────────────');
  console.log('DO THIS IN THE BROWSER WINDOW:');
  console.log('  1. Log in with your username and password.');
  console.log('  2. Click Work Orders → Work Orders List.');
  console.log('  3. Click the VIEW button on your work order.');
  console.log('──────────────────────────────────────────────────');
  console.log('\nWaiting for work order popup (up to 5 minutes)...\n');

  // Auto-detect the popup — no ENTER needed
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
      // Every 15s print a status line showing all open pages
      if (tick % 15 === 0) {
        const urls = context.pages().map((p) => p.url());
        console.log(`  [${Math.round((deadline - Date.now()) / 1000)}s left] Open pages: ${urls.join(' | ')}`);
      } else {
        process.stdout.write('.');
      }
    }
  }
  if (!workPage) {
    console.error('\n\nTimed out. Make sure you clicked View on the work order.');
    await browser.close();
    process.exit(1);
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log('Work order popup detected.');
  console.log('Navigate to the correct work order, then press ENTER to begin.');
  console.log('──────────────────────────────────────────────────');
  await ask('Press ENTER when ready...');

  // Give the page a moment to fully settle after any navigation
  await new Promise((r) => setTimeout(r, 2000));

  console.log(`\nStarting automation...\n`);

  const startTime = Date.now();
  let ladderResults;
  try {
    ladderResults = await runAutomation(records, workPage, AUTOMATION_OPTS);
  } catch (err: unknown) {
    console.error(`\nFATAL ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    await ask('Press ENTER to close the browser and exit...');
    await browser.close();
    process.exit(1);
  }

  const durationMs = Date.now() - startTime;
  const summary = buildSummary(ladderResults, durationMs);
  printSummary(summary);

  const logPath = writeJsonLog(summary);
  console.log(`\nDetailed log: ${logPath}\n`);

  const hasIssues =
    summary.errorLadders > 0 || summary.partialLadders > 0 || summary.failedParts > 0;

  if (hasIssues) {
    console.log('⚠  Some items had issues — review the exceptions above before submitting.');
  } else {
    console.log('✓  All ladders and parts added successfully.');
  }

  console.log('\nReview the work order in the browser, then submit manually.');
  console.log('This window will stay open. Close it manually when done, or press Ctrl+C.\n');
  // Keep the process alive so the browser stays open
  await new Promise(() => { /* intentional: user closes when ready */ });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
