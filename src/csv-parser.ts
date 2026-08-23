import fs from 'fs';
import Papa from 'papaparse';
import type { LadderRecord, PartEntry } from './types.js';
import { partColumns, FLAG_COLS, parseFlagValue } from './core/csv-columns.js';
import { parsePartValue } from './core/part-value.js';

interface CsvRow { [key: string]: string | undefined; }

export interface ParseResult {
  records: LadderRecord[];
  skipped: Array<{ row: number; serialNum: string; reason: string }>;
}

export function parseCsv(filePath: string): ParseResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const result = Papa.parse<CsvRow>(content, { header: true, skipEmptyLines: true });

  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.type === 'Delimiter' || e.type === 'Quotes');
    if (fatal) throw new Error(`CSV parse error: ${fatal.message}`);
  }

  const headers = result.meta.fields ?? [];
  const partCols = partColumns(headers);

  const records: LadderRecord[] = [];
  const skipped: ParseResult['skipped'] = [];

  result.data.forEach((row, idx) => {
    const rowNum = idx + 2;
    const serial = row['Serial #']?.trim() ?? '';
    if (!serial) {
      skipped.push({ row: rowNum, serialNum: '(blank)', reason: 'Missing Serial #' });
      return;
    }

    const brand  = row['Brand']?.trim()       ?? '';
    const type   = row['Type']?.trim()        ?? '';
    const length = row['Length']?.trim()      ?? '';
    const desc   = row['Description']?.trim() ?? '';

    const parts: PartEntry[] = partCols
      .map((col) => parsePartValue(row[col] ?? ''))
      .filter((p): p is PartEntry => p !== null);

    records.push({
      serialNum: serial,
      truckId: row['Location ID']?.trim() || '1',
      brand,
      type,
      length,
      desc,
      parts,
      flags: {
        leveler:    parseFlagValue(row[FLAG_COLS.leveler]),
        claw:       parseFlagValue(row[FLAG_COLS.claw]),
        vrung:      parseFlagValue(row[FLAG_COLS.vrung]),
        lubricated: parseFlagValue(row[FLAG_COLS.lubricated]),
      },
    });
  });

  return { records, skipped };
}
