// Bundled by `npm run build:core` into dist/lia-core.cjs so electron/main.cjs
// (CommonJS) can share this logic with the TypeScript import path instead of
// keeping its own copy.

export {
  METADATA_COLS, CUSTOM_COL_PREFIX, FLAG_COL_PREFIX, FLAG_COLS,
  isPartColumn, partColumns, parseFlagValue, type FlagName,
} from './csv-columns.js';
export { parsePartValue, type PartEntry } from './part-value.js';
export {
  mergeRecords, unionParts, serialKey, SUSPECT_SKEW_MS,
  type MergeRecord, type MergedItem, type MergeResult, type FieldConflict, type Scope,
} from './merge.js';
