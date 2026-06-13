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

  // Verification result — CSV vs final work-order state
  const v = summary.verification;
  if (v) {
    if (v.matched) {
      if (v.intentionallySkipped?.length) {
        console.log(`\n✓  VERIFIED (${v.passes} pass${v.passes === 1 ? '' : 'es'}) — no unintentional mismatches. ${v.intentionallySkipped.length} item(s) below were intentionally left as-is (boxes-only mode) and do NOT match the CSV.`);
      } else {
        console.log(`\n✓  VERIFIED (${v.passes} pass${v.passes === 1 ? '' : 'es'}) — every CSV line matches the work order.`);
      }
    } else {
      console.log('\n╔══════════════════════════════════════════════════════════╗');
      console.log('║  ✗  VERIFICATION FAILED — work order does NOT match CSV ║');
      console.log('╚══════════════════════════════════════════════════════════╝\n');
      console.log(`  Checked ${v.passes} time(s), re-imported ${v.fixAttempts} time(s); still missing:`);
      for (const sn of v.missingBoxes) console.log(`  ✗  SN ${sn}: ladder not on work order`);
      for (const g of v.missingParts) console.log(`  ⚠  SN ${g.serialNum}: missing parts ${g.parts.join(', ')}`);
      console.log('\n  Add these manually in bsiwebapp.com, then re-run to confirm.\n');
    }
    if (v.intentionallySkipped?.length) {
      console.log('  Skipped by your choice (boxes-only mode):');
      for (const g of v.intentionallySkipped) console.log(`  -  SN ${g.serialNum}: ${g.parts.join(', ')}`);
    }
  }

  // Prominent exceptions block — anything the user needs to fix manually
  const needsAttention = summary.ladderResults.filter(
    (r) => r.status !== 'success',
  );

  // Cost flags
  if (summary.flaggedLadders && summary.flaggedLadders.length > 0) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  ⚑  COST FLAGS — Review these with your supervisor      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    for (const f of summary.flaggedLadders) {
      const reason = f.reason === 'pm36-high-cost'
        ? `PM36 repair total $${f.totalCost.toFixed(2)} exceeds $90 threshold`
        : `Repair total $${f.totalCost.toFixed(2)} exceeds $250 threshold`;
      console.log(`  ⚑  SN ${f.serialNum}: ${reason}`);
      console.log(`     Parts: ${f.parts.join(', ')}`);
      console.log('');
    }
  }

  if (needsAttention.length === 0) {
    if (!summary.flaggedLadders?.length) {
      console.log('\n✓  No exceptions — all ladders processed successfully.\n');
    }
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
