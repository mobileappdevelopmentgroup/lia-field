// Single source of truth for how a ladder CSV's columns are classified.
//
// This lived in two places — src/csv-parser.ts and electron/main.cjs — and the two
// copies drifted: main.cjs excluded "[Custom] " columns, csv-parser.ts did not. The
// renderer preview was therefore correct while the import that actually ran was not,
// and every custom field a tech typed in Lia Field was searched for as a BSI part.

// Columns that describe the ladder itself rather than a part fitted to it.
export const METADATA_COLS: ReadonlySet<string> = new Set([
  'Row#',
  'Serial #',
  'Location ID',
  'Brand',
  'Type',
  'Length',
  'Description',
  // Lia Field's "properly lubricated?" observation. Listed here so it can never be
  // mistaken for a part number; CSVs written before it existed simply omit the column.
  'Lubricated',
]);

// Lia Field prefixes user-defined fields so they stay distinguishable from parts.
// See buildCsv() in field-app/index.html.
export const CUSTOM_COL_PREFIX = '[Custom] ';

export function isPartColumn(header: string): boolean {
  return !METADATA_COLS.has(header) && !header.startsWith(CUSTOM_COL_PREFIX);
}

export function partColumns(headers: readonly string[]): string[] {
  return headers.filter(isPartColumn);
}
