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

export interface VerificationGap {
  serialNum: string;
  parts: string[];   // CSV search terms still missing from this box
}

export interface VerificationReport {
  passes: number;          // verification passes run (1–5)
  fixAttempts: number;     // re-import attempts made to close mismatches
  matched: boolean;        // true when every CSV line is on the work order
  missingBoxes: string[];  // serials in CSV still absent from the work order
  missingParts: VerificationGap[];          // boxes still missing CSV parts
  intentionallySkipped?: VerificationGap[]; // boxes-only mode: gaps the user chose to leave
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
  flaggedLadders?: FlaggedLadder[];   // high-cost or PM36+cost red flags
  verification?: VerificationReport;  // post-import CSV vs work-order check
}

// ── Diff / idempotent re-run types ───────────────────────────────────────────

export interface WorkOrderBox {
  selector: string;    // e.g. "#box-3"
  serialNum: string;   // from #boxserialnumberh-{N} input value
  partNums: string[];  // part numbers from table rows (e.g. ["M23","R28L","RC"])
  totalCost?: number;  // dollar total shown by BSI for this box, if scraped
}

export type FlagReason = 'pm36-high-cost' | 'high-cost';

export interface FlaggedLadder {
  serialNum: string;
  totalCost: number;
  reason: FlagReason;
  parts: string[];
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
