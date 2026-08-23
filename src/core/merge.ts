// Merging several technicians' captures of one work order.
//
// A lead subcontracts; two or three techs work the same work order on their own
// phones. Their records have to become one clean set before an import, without
// losing anything and without silently picking a winner the lead never saw.
//
// The rules here are deliberate, and two of them are the opposite of the
// obvious choice:
//
//   * Whole record wins — parts are NOT unioned. Unioning two techs' part lists
//     double-adds parts in BSI and double-bills the customer. Union is offered
//     per row in the review UI, never applied automatically.
//   * A FAIL always beats a PASS, whatever the timestamps say. If one tech
//     condemned an item, that is the safety-relevant fact.
//
// Everything else is last-capture-wins, with every genuine disagreement
// surfaced rather than resolved quietly.

export type Scope = 'ladder' | 'fall_protection';

export interface MergeRecord {
  /** Stable id of the capture on the device that produced it. */
  clientId: string;
  serialNum: string;
  scope: Scope;
  /** Device clock. Suspect — see clockSkewMs. */
  capturedAt: string;
  /** Server clock, set on upload. Trustworthy. */
  uploadedAt?: string;
  techName: string;
  techUserId?: string;
  deviceId?: string;
  /** Device clock offset measured against the server at sign-in. */
  clockSkewMs?: number;
  /** True when the tech deleted this item after uploading it. */
  deleted?: boolean;
  overallPass?: boolean;
  parts?: Array<{ searchTerm: string; quantity: number }>;
  [field: string]: unknown;
}

export interface FieldConflict {
  field: string;
  values: Array<{ techName: string; value: unknown; capturedAt: string }>;
}

export interface MergedItem {
  serialNum: string;
  scope: Scope;
  /** The record that won, after the rules above. */
  winner: MergeRecord;
  /** Everything that contributed, newest first. Never discarded. */
  contributors: MergeRecord[];
  /** Genuine disagreements, for the lead to look at. Empty when they agree. */
  conflicts: FieldConflict[];
  /** Set when a FAIL overrode a newer PASS. */
  failOverrodePass?: boolean;
  /** Set when the winner was chosen using a clock we do not trust. */
  suspectClock?: boolean;
}

export interface MergeResult {
  items: MergedItem[];
  /** Items where two techs disagree about something. */
  conflicted: MergedItem[];
  /** Removed because a tech deleted them after uploading. */
  tombstoned: string[];
  contributorSummary: Array<{ techName: string; captured: number; deviceId?: string; skewMs?: number }>;
}

/** Matches serial_key() in the database. The two must not drift. */
export function serialKey(s: string): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A device this far out is not trustworthy as a tiebreaker. */
export const SUSPECT_SKEW_MS = 5 * 60 * 1000;

// Fields compared for disagreement. Bookkeeping is excluded — two techs having
// different device ids is not a conflict.
const IGNORED = new Set([
  'clientId', 'capturedAt', 'uploadedAt', 'techName', 'techUserId', 'deviceId',
  'clockSkewMs', 'deleted', 'parts', 'checks', 'photo', 'id',
]);

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  return String(a) === String(b);
}

// Newest first. Server upload time breaks ties, because a device clock can be
// wrong and the server's cannot.
function byRecency(a: MergeRecord, b: MergeRecord): number {
  const t = Date.parse(b.capturedAt) - Date.parse(a.capturedAt);
  if (t !== 0) return t;
  const u = Date.parse(b.uploadedAt ?? '') - Date.parse(a.uploadedAt ?? '');
  if (!Number.isNaN(u) && u !== 0) return u;
  return String(b.clientId).localeCompare(String(a.clientId));
}

export function mergeRecords(records: MergeRecord[]): MergeResult {
  const groups = new Map<string, MergeRecord[]>();
  for (const r of records) {
    // A ladder and a fall-protection item may legitimately share a serial, so
    // scope is part of identity.
    const key = `${r.scope}::${serialKey(r.serialNum)}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }

  const items: MergedItem[] = [];
  const tombstoned: string[] = [];

  for (const [, group] of groups) {
    const sorted = [...group].sort(byRecency);

    // A delete is only honoured when it is the most recent word on the item —
    // otherwise re-capturing something a tech deleted earlier would be undone.
    if (sorted[0].deleted) {
      tombstoned.push(sorted[0].serialNum);
      continue;
    }

    const live = sorted.filter((r) => !r.deleted);
    if (!live.length) continue;

    let winner = live[0];
    let failOverrodePass = false;

    // Safety outranks recency: if any tech failed this item, that stands even
    // if someone passed it later.
    const failed = live.find((r) => r.overallPass === false);
    if (failed && winner.overallPass !== false) {
      winner = failed;
      failOverrodePass = true;
    }

    const conflicts: FieldConflict[] = [];
    if (live.length > 1) {
      const fields = new Set<string>();
      for (const r of live) for (const k of Object.keys(r)) if (!IGNORED.has(k)) fields.add(k);

      for (const f of fields) {
        const present = live.filter((r) => !isEmpty(r[f]));
        if (present.length < 2) continue;
        const differs = present.some((r) => !sameValue(r[f], present[0][f]));
        if (!differs) continue;
        conflicts.push({
          field: f,
          values: present.map((r) => ({ techName: r.techName, value: r[f], capturedAt: r.capturedAt })),
        });
      }

      // Parts are reported as a disagreement but never merged — see the header.
      const partSets = live.map((r) => (r.parts ?? []).map((p) => `${p.searchTerm}×${p.quantity}`).sort().join(','));
      if (new Set(partSets).size > 1) {
        conflicts.push({
          field: 'parts',
          values: live.map((r) => ({
            techName: r.techName,
            value: (r.parts ?? []).map((p) => (p.quantity > 1 ? `(${p.quantity}) ${p.searchTerm}` : p.searchTerm)).join(', '),
            capturedAt: r.capturedAt,
          })),
        });
      }
    }

    // "Latest wins" is only as good as the clocks it compares.
    const suspectClock = live.length > 1
      && live.some((r) => Math.abs(r.clockSkewMs ?? 0) > SUSPECT_SKEW_MS);

    items.push({
      serialNum: winner.serialNum,
      scope: winner.scope,
      winner,
      contributors: sorted,
      conflicts,
      ...(failOverrodePass ? { failOverrodePass } : {}),
      ...(suspectClock ? { suspectClock } : {}),
    });
  }

  items.sort((a, b) => a.serialNum.localeCompare(b.serialNum, undefined, { numeric: true }));

  const byTech = new Map<string, { techName: string; captured: number; deviceId?: string; skewMs?: number }>();
  for (const r of records) {
    const e = byTech.get(r.techName) ?? { techName: r.techName, captured: 0, deviceId: r.deviceId, skewMs: r.clockSkewMs };
    e.captured += 1;
    byTech.set(r.techName, e);
  }

  return {
    items,
    conflicted: items.filter((i) => i.conflicts.length > 0),
    tombstoned,
    contributorSummary: [...byTech.values()].sort((a, b) => b.captured - a.captured),
  };
}

/** Union the parts across contributors — only ever on an explicit per-row choice. */
export function unionParts(item: MergedItem): Array<{ searchTerm: string; quantity: number }> {
  const out = new Map<string, number>();
  for (const r of item.contributors) {
    for (const p of r.parts ?? []) {
      const k = p.searchTerm.toUpperCase();
      // Highest quantity, not the sum: two techs each recording "2 rungs" saw
      // the same two rungs.
      out.set(k, Math.max(out.get(k) ?? 0, p.quantity));
    }
  }
  return [...out.entries()].map(([searchTerm, quantity]) => ({ searchTerm, quantity }));
}
