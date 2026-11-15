// bestMatch() decides which BSI part goes on an invoice. Field report
// 2026-11-14: unrelated parts (LG4, E7, L6) were landing on boxes, because
// with no matching option it used to take the first one BSI listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestMatch } from './automation.js';

const opt = (code: string, desc = 'PART') => ({ value: code + '-id', text: `${code} – ${desc}` });

test('an exact code wins', () => {
  assert.equal(bestMatch([opt('LG4'), opt('LGH36F')], 'LGH36F')?.value, 'LGH36F-id');
});

test('nothing matching means nothing — never the first option BSI listed', () => {
  assert.equal(bestMatch([opt('LG4'), opt('E7')], 'LGH36F'), undefined);
});

test('the right part already in the box never turns into a different part', () => {
  // BSI lists LGH36F (already in the box) and LG4. The old fallback picked LG4.
  const m = bestMatch([opt('LGH36F'), opt('LG4')], 'LGH36F', new Set(['LGH36F']));
  assert.equal(m?.value, 'LGH36F-id', 'hands back the duplicate so the caller skips it');
});

test('punctuation in a code does not stop a match', () => {
  assert.equal(bestMatch([opt('G-13'), opt('G14')], 'G13')?.value, 'G-13-id');
});

test('a search term inside a longer code still matches, as before', () => {
  assert.equal(bestMatch([opt('LG4'), opt('SLS375')], 'S375')?.value, 'SLS375-id');
});

test('a blank search term matches nothing', () => {
  assert.equal(bestMatch([opt('LG4')], '  '), undefined);
});
