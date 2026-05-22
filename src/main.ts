import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { run } from './runner.js';

const CSV_DIR = path.join(process.cwd(), 'Ladders - Add your csv file here');

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function getCsvPath(): string {
  const flag = process.argv.indexOf('--csv');
  if (flag !== -1 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1]);
  if (fs.existsSync(CSV_DIR)) {
    const files = fs.readdirSync(CSV_DIR).filter((f) => f.toLowerCase().endsWith('.csv') && !f.startsWith('.'));
    if (files.length > 0) return path.join(CSV_DIR, files[0]);
  }
  return path.join(CSV_DIR, 'ladders.csv');
}

async function main(): Promise<void> {
  const csvPath = getCsvPath();
  const waitForReady = async () => { await ask('Press ENTER when ready...'); };

  const result = await run(csvPath, waitForReady);

  if (!result.success) {
    console.error(`\nERROR: ${result.error}`);
    process.exit(1);
  }

  const hasIssues =
    result.summary && (result.summary.errorLadders > 0 || result.summary.partialLadders > 0 || result.summary.failedParts > 0);

  if (hasIssues) {
    console.log('⚠  Some items had issues — review the exceptions above before submitting.');
  } else {
    console.log('✓  All ladders and parts added successfully.');
  }

  console.log('\nReview the work order in the browser, then submit manually.');
  console.log('This window will stay open. Close it manually when done, or press Ctrl+C.\n');
  await new Promise(() => { /* intentional: keep open */ });
}

main().catch((err) => { console.error(err); process.exit(1); });
