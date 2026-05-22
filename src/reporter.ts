import fs from 'fs';
import path from 'path';
import Table from 'cli-table3';
import type { LadderResult, RunSummary } from './types.js';

function statusIcon(s: string): string {
  return { success: '✓', partial: '~', skipped: '-', error: '✗' }[s] ?? '?';
}

export function buildSummary(ladderResults: LadderResult[], durationMs: number): RunSummary {
  const counts = { success: 0, partial: 0, skipped: 0, duplicate: 0, error: 0 };
  let totalParts = 0;
  let successParts = 0;

  for (const r of ladderResults) {
    counts[r.status as keyof typeof counts] = (counts[r.status as keyof typeof counts] ?? 0) + 1;
    totalParts += r.partsTotal;
    successParts += r.partsOk;
  }

  return {
    totalLadders: ladderResults.length,
    successLadders: counts.success,
    partialLadders: counts.partial,
    skippedLadders: counts.skipped + counts.duplicate,
    errorLadders: counts.error,
    totalParts,
    successParts,
    failedParts: totalParts - successParts,
    ladderResults,
    durationMs,
  };
}

export function printSummary(summary: RunSummary): void {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  RUN SUMMARY');
  console.log('═══════════════════════════════════════════════════\n');

  const ladderTable = new Table({
    head: ['Serial #', 'Status', 'Parts OK', 'Total', 'Exceptions / Selected'],
    colWidths: [14, 10, 10, 8, 55],
    wordWrap: true,
  });

  for (const r of summary.ladderResults) {
    const exceptions = r.partResults
      .map((p) => {
        if (p.status === 'success') return `✓ ${p.searchTerm} → ${p.selectedOption ?? ''}`;
        return `✗ ${p.searchTerm}: ${p.status}${p.message ? ` (${p.message.slice(0, 35)})` : ''}`;
      })
      .join('\n');

    ladderTable.push([
      r.serialNum,
      `${statusIcon(r.status)} ${r.status}`,
      String(r.partsOk),
      String(r.partsTotal),
      exceptions || (r.errorMsg ? r.errorMsg.slice(0, 50) : '—'),
    ]);
  }

  console.log(ladderTable.toString());

  const totalsTable = new Table({
    head: ['Metric', 'Count'],
    colWidths: [35, 8],
  });

  totalsTable.push(
    ['Total Ladders', summary.totalLadders],
    ['  ✓ Success', summary.successLadders],
    ['  ~ Partial (some parts failed)', summary.partialLadders],
    ['  - Skipped (bad CSV row)', summary.skippedLadders],
    ['  ✗ Error', summary.errorLadders],
    ['Total Parts', summary.totalParts],
    ['  ✓ Added', summary.successParts],
    ['  ✗ Failed / Not Found', summary.failedParts],
    ['Duration', `${(summary.durationMs / 1000).toFixed(1)}s`],
  );

  console.log(totalsTable.toString());

  // Prominent exceptions block — anything the user needs to fix manually
  const needsAttention = summary.ladderResults.filter(
    (r) => r.status !== 'success',
  );

  if (needsAttention.length === 0) {
    console.log('\n✓  No exceptions — all ladders processed successfully.\n');
    return;
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  ACTION REQUIRED — Fix these manually in bsiwebapp.com  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  for (const r of needsAttention) {
    const label =
      r.status === 'duplicate' ? '  DUPLICATE (already on work order)'
      : r.status === 'skipped'  ? '  SKIPPED   (serial not found in BSI)'
      : r.status === 'error'    ? '  ERROR     (script crashed on this ladder)'
      :                           '  PARTIAL   (some parts failed)';

    console.log(`  Serial: ${r.serialNum}`);
    console.log(`  Reason: ${label}`);
    if (r.errorMsg) console.log(`  Detail: ${r.errorMsg}`);

    const failedParts = r.partResults.filter((p) => p.status !== 'success');
    for (const p of failedParts) {
      console.log(`    Part "${p.searchTerm}" → ${p.status}: ${p.message ?? ''}`);
    }
    console.log('');
  }
}

export function writeJsonLog(summary: RunSummary, logsDir?: string): string {
  const dir = logsDir ?? path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(dir, `run-${ts}.json`);
  fs.writeFileSync(logPath, JSON.stringify(summary, null, 2));
  return logPath;
}
