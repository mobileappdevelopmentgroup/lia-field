export interface PartEntry {
  searchTerm: string;
  quantity: number;
}

export interface LadderRecord {
  serialNum: string;
  truckId: string;
  brand: string;
  type: string;
  length: string;
  desc: string;
  parts: PartEntry[];
}

export type PartStatus = 'success' | 'not_found' | 'error' | 'skipped';

export interface PartResult {
  searchTerm: string;
  status: PartStatus;
  selectedOption?: string;
  message?: string;
}

export type LadderStatus = 'success' | 'partial' | 'skipped' | 'duplicate' | 'error';

export interface LadderResult {
  serialNum: string;
  status: LadderStatus;
  partsTotal: number;
  partsOk: number;
  partResults: PartResult[];
  errorMsg?: string;
}

export interface ExtraPartEntry {
  boxSerial: string;   // serial number of the box that has the extra part
  partNum: string;     // part number found in BSI but not in CSV
}

export interface RunSummary {
  totalLadders: number;
  successLadders: number;
  partialLadders: number;
  skippedLadders: number;
  errorLadders: number;
  totalParts: number;
  successParts: number;
  failedParts: number;
  ladderResults: LadderResult[];
  durationMs: number;
  extraOnWorkOrder?: ExtraPartEntry[]; // parts in BSI boxes not found in CSV
}

// ── Diff / idempotent re-run types ───────────────────────────────────────────

export interface WorkOrderBox {
  selector: string;    // e.g. "#box-3"
  serialNum: string;   // from #boxserialnumberh-{N} input value
  partNums: string[];  // part numbers from table rows (e.g. ["M23","R28L","RC"])
}

export interface DiffItemWithGaps {
  record: LadderRecord;
  boxSelector: string;
  missingParts: PartEntry[];
  presentParts: string[];   // searchTerms detected in box text
}

export interface DiffResult {
  missingBoxes: LadderRecord[];        // in CSV, not on work order
  existingWithGaps: DiffItemWithGaps[]; // on work order but has missing parts
  alreadyComplete: LadderRecord[];     // on work order and appears fully done
}

export type DiffChoice = 'all' | 'boxes-only' | 'cancel';

export interface AutomationOptions {
  dropdownTimeout: number;     // ms to wait for a dropdown/search to populate
  pauseBetweenLadders: number; // ms between finishing one ladder and starting next
  actionDelay: number;         // ms after every click/fill/select
  serialApiDelay: number;      // ms to wait after serial confirmation for API to populate fields
}
