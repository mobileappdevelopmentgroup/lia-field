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

export type PartStatus = 'success' | 'not_found' | 'error';

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
}

export interface AutomationOptions {
  dropdownTimeout: number;     // ms to wait for a dropdown/search to populate
  pauseBetweenLadders: number; // ms between finishing one ladder and starting next
  actionDelay: number;         // ms after every click/fill/select
  serialApiDelay: number;      // ms to wait after serial confirmation for API to populate fields
}

export interface Config {
  username: string;
  password: string;
}
