import fs from 'fs';
import Papa from 'papaparse';
import type { LadderRecord, PartEntry } from './types.js';

// Everything that isn't metadata is treated as a part column (C&S, Rope, SLS-1, lbs, A, B, C, D, …)
const METADATA_COLS = new Set(['Row#', 'Serial #', 'Location ID', 'Brand', 'Type', 'Length', 'Description']);

interface CsvRow { [key: string]: string | undefined; }

export interface ParseResult {
  records: LadderRecord[];
  skipped: Array<{ row: number; serialNum: string; reason: string }>;
}

// "(2) G13"  → { searchTerm: "G13", quantity: 2 }  (qty prefix)
// "W44 (2)"  → { searchTerm: "W44", quantity: 2 }  (qty suffix)
// "PM36"     → { searchTerm: "PM36", quantity: 1 }
// ""         → null (skip)
function parsePartValue(val: string): PartEntry | null {
  const v = val.trim();
  if (!v) return null;
  // Qty as prefix: "(2) G13"
  let m = v.match(/^\((\d+)\)\s*(.+)$/);
  if (m) {
    const qty = parseInt(m[1], 10);
    const term = m[2].trim();
    return term ? { searchTerm: term, quantity: qty } : null;
  }
  // Qty as suffix: "W44 (2)"
  m = v.match(/^(.+?)\s*\((\d+)\)$/);
  if (m) {
    const term = m[1].trim();
    const qty = parseInt(m[2], 10);
    return term ? { searchTerm: term, quantity: qty } : null;
  }
  return { searchTerm: v, quantity: 1 };
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
  const partCols = headers.filter((h) => !METADATA_COLS.has(h));

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
    });
  });

  return { records, skipped };
}
