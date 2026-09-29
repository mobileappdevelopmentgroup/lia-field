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

// The four BSI checkboxes that sit under the Length field. They are prefixed
// rather than named bare because three of them collide with real part numbers —
// "Levelers" is in the field app's own seed catalogue, and Claw and V-Rung are
// part numbers too. A bare "Claw" column would silently swallow a real part.
export const FLAG_COL_PREFIX = '[Flag] ';

export const FLAG_COLS = {
  leveler:    FLAG_COL_PREFIX + 'Leveler',
  claw:       FLAG_COL_PREFIX + 'Claw',
  vrung:      FLAG_COL_PREFIX + 'V-Rung',
  lubricated: FLAG_COL_PREFIX + 'Lubricated',
} as const;

export type FlagName = keyof typeof FLAG_COLS;

// Tri-state: true / false / null for "not assessed". Null must stay
// distinguishable from false — the automation only ever ticks a box, it never
// unticks one, so "no" and "didn't look" lead to different behaviour.
export function parseFlagValue(val: string | null | undefined): boolean | null {
  const v = (val ?? '').trim().toLowerCase();
  if (!v) return null;
  if (['y', 'yes', 'true', '1', 'x'].includes(v)) return true;
  if (['n', 'no', 'false', '0'].includes(v)) return false;
  return null;
}

export function isPartColumn(header: string): boolean {
  return !METADATA_COLS.has(header)
    && !header.startsWith(CUSTOM_COL_PREFIX)
    && !header.startsWith(FLAG_COL_PREFIX);
}

export function partColumns(headers: readonly string[]): string[] {
  return headers.filter(isPartColumn);
}
