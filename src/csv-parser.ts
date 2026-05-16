import fs from 'fs';
import Papa from 'papaparse';
import type { LadderRecord, PartEntry } from './types.js';

interface CsvRow {
  SerialNum: string;
  TruckID?: string;
  Brand?: string;
  Type?: string;
  Length?: string;
  Desc?: string;
  [key: string]: string | undefined;
}

export interface ParseResult {
  records: LadderRecord[];
  skipped: Array<{ row: number; serialNum: string; reason: string }>;
}

export function parseCsv(filePath: string): ParseResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const result = Papa.parse<CsvRow>(content, {
    header: true,
    skipEmptyLines: true,
  });

  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.type === 'Delimiter' || e.type === 'Quotes');
    if (fatal) throw new Error(`CSV parse error: ${fatal.message}`);
  }

  const headers = result.meta.fields ?? [];

  // Collect unique part indices: Part1, Part2, ... → ['1', '2', ...]
  const partIndices = [
    ...new Set(
      headers
        .filter((h) => /^Part\d+$/.test(h))
        .map((h) => h.replace('Part', '')),
    ),
  ].sort((a, b) => Number(a) - Number(b));

  const records: LadderRecord[] = [];
  const skipped: ParseResult['skipped'] = [];

  result.data.forEach((row, idx) => {
    const rowNum = idx + 2;
    if (!row.SerialNum?.trim()) {
      skipped.push({
        row: rowNum,
        serialNum: '(blank)',
        reason: 'Missing required column: SerialNum',
      });
      return;
    }

    const parts: PartEntry[] = partIndices
      .map((n) => ({
        searchTerm: (row[`Part${n}`] ?? '').trim(),
        quantity: parseInt((row[`Part${n}Qty`] ?? '1').trim(), 10) || 1,
      }))
      .filter((p) => p.searchTerm !== '');

    records.push({
      serialNum: row.SerialNum.trim(),
      truckId: row.TruckID?.trim() ?? '',
      brand: row.Brand?.trim() ?? '',
      type: row.Type?.trim() ?? '',
      length: row.Length?.trim() ?? '',
      desc: row.Desc?.trim() ?? '',
      parts,
    });
  });

  return { records, skipped };
}
