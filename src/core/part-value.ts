// Quantity is encoded inline in a part cell, either as a prefix or a suffix:
//
//   "(2) G13"  → { searchTerm: "G13",  quantity: 2 }
//   "W44 (2)"  → { searchTerm: "W44",  quantity: 2 }
//   "PM36"     → { searchTerm: "PM36", quantity: 1 }
//   ""         → null (skip)

import type { PartEntry } from '../types.js';

export type { PartEntry };

export function parsePartValue(val: string | null | undefined): PartEntry | null {
  const v = (val ?? '').trim();
  if (!v) return null;

  let m = v.match(/^\((\d+)\)\s*(.+)$/);
  if (m) {
    const term = m[2].trim();
    return term ? { searchTerm: term, quantity: parseInt(m[1], 10) } : null;
  }

  m = v.match(/^(.+?)\s*\((\d+)\)$/);
  if (m) {
    const term = m[1].trim();
    return term ? { searchTerm: term, quantity: parseInt(m[2], 10) } : null;
  }

  return { searchTerm: v, quantity: 1 };
}
