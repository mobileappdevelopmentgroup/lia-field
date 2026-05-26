import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  AutomationOptions,
  LadderRecord,
  LadderResult,
  PartEntry,
  PartResult,
} from './types.js';

// Use BATAVIA_LOGS_DIR when set (packaged app sets this to ~/Documents/Lia Logs),
// otherwise fall back to a writable temp directory so we never try to write to /logs.
const LOGS_DIR = process.env['BATAVIA_LOGS_DIR'] ?? path.join(os.tmpdir(), 'lia-logs');

// CSV abbreviation → BSI dropdown search term.
// The value just needs to be a substring of the actual option text (case-insensitive).
// Update these if BSI's dropdown text ever changes.
// Maps CSV abbreviations → BSI dropdown text.
// When a CSV value is NOT in this map it is passed raw to keyboardSelectDropdown,
// which tries multiple fuzzy strategies (see below) — so unknown abbrevs may still match.
const BRAND_ABBREV: Record<string, string> = {
  // Little Giant
  lg: 'Little Giant', littleg: 'Little Giant', litg: 'Little Giant',
  little: 'Little Giant', giant: 'Little Giant', litlegi: 'Little Giant',
  // Louisville
  lou: 'Louisville', louis: 'Louisville', louie: 'Louisville',
  louisv: 'Louisville', louisville: 'Louisville', loui: 'Louisville',
  // Werner
  wer: 'Werner', werner: 'Werner',
  // Featherlite
  fea: 'Featherlite', feath: 'Featherlite', feather: 'Featherlite',
  // Babcock
  bab: 'Babcock', babcock: 'Babcock',
  // Ballymore
  bal: 'Ballymore', ball: 'Ballymore', ballym: 'Ballymore',
  // Bauer
  bau: 'Bauer', bauer: 'Bauer',
  // Grn Bull
  grn: 'Grn Bull', grnb: 'Grn Bull', bull: 'Grn Bull',
  // Lock-n-climb
  loc: 'Lock-n-climb', lock: 'Lock-n-climb', locknc: 'Lock-n-climb',
  // Lynn
  lyn: 'Lynn', lynn: 'Lynn',
  // Putnam
  put: 'Putnam', putnam: 'Putnam',
  // Sunset
  sun: 'Sunset', sunset: 'Sunset',
  // Other
  oth: 'Other', other: 'Other',
};

// Values must match BSI dropdown text exactly (case-insensitive partial match is fine).
const TYPE_ABBREV: Record<string, string> = {
  ext:    'Ext',
  combo:  'Combo',
  com:    'Combo',
  comp:   'Composite',
  dbl:    'Dbl Step',
  mhole:  'Mhole',
  other:  'Other',
  pltfrm: 'Pltfrm Stp',
  rack:   'Rack',
  roll:   'Rolling',
  ste:    'Step',
  step:   'Step',
  str:    'Straight',
};

function expandAbbrev(map: Record<string, string>, value: string): string {
  return map[value.trim().toLowerCase()] ?? value;
}

// ── Pause / Resume controller ─────────────────────────────────────────────────

let _paused = false;
const _pauseWaiters: Array<() => void> = [];

export function setPaused(paused: boolean): void {
  _paused = paused;
  if (!paused && _pauseWaiters.length > 0) {
    const resolvers = _pauseWaiters.splice(0);
    resolvers.forEach(r => r());
  }
}

async function checkPaused(): Promise<void> {
  if (!_paused) return;
  console.log('  ⏸  Import paused — waiting for resume...');
  await new Promise<void>(resolve => _pauseWaiters.push(resolve));
  console.log('  ▶  Resuming import...');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function screenshot(page: Page, label: string): Promise<void> {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const file = path.join(LOGS_DIR, `error-${label}-${Date.now()}.png`);
  await page.screenshot({ path: file }).catch(() => undefined);
  console.error(`  Screenshot saved: ${file}`);
}

// Wait for network to go quiet — best effort, never throws.
async function waitForNetworkIdle(page: Page, timeout = 6_000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
}

// Case-insensitive label match for <select>. No-op if label is empty.
async function selectByLabel(page: Page, selector: string, label: string): Promise<void> {
  if (!label) return;
  const normalized = label.trim().toLowerCase();
  const value = await page.locator(`${selector} option`).evaluateAll(
    (opts, norm) => {
      const o = (opts as HTMLOptionElement[]).find(
        (opt) =>
          opt.text.trim().toLowerCase() === norm ||
          opt.text.trim().toLowerCase().includes(norm),
      );
      return o?.value ?? null;
    },
    normalized,
  );
  if (!value) throw new Error(`No option matching "${label}" in ${selector}`);
  await page.locator(selector).selectOption(value);
}

// Fill a text field only when it is currently empty.
async function fillIfEmpty(
  page: Page,
  ariaLabel: string,
  value: string,
  delay: number,
): Promise<void> {
  if (!value) return;
  const field = page.getByRole('textbox', { name: ariaLabel });
  const current = await field.inputValue().catch(() => '');
  if (!current.trim()) {
    await field.dblclick();
    await pause(300);
    await field.fill(value);
    await pause(delay);
  }
}

// Select a <select> only when it has no meaningful selection yet (existing-serial path).
// Non-throwing: logs a warning and continues if the element is missing or has no match.
async function selectIfEmpty(
  page: Page,
  selector: string,
  label: string,
  delay: number,
): Promise<void> {
  if (!label) return;
  try {
    const current = await page.locator(selector).evaluate((el) => {
      const s = el as HTMLSelectElement;
      return s.options[s.selectedIndex]?.text?.trim() ?? '';
    }).catch(() => '');
    const isPlaceholder =
      !current || current.toLowerCase().includes('select') || current === '-' || current === '--';
    if (isPlaceholder) {
      await selectByLabel(page, selector, label);
      await pause(delay);
    }
  } catch (err: unknown) {
    console.warn(`  [WARN] Could not set ${selector} to "${label}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Navigate a BSI dropdown with keyboard: Home to reset, then ArrowDown to the target.
// BSI requires real key events for field validation (selectOption() bypasses its handlers).
async function keyboardSelectDropdown(
  page: Page,
  selector: string,
  label: string,
  delay: number,
): Promise<void> {
  if (!label) return;
  const normalized = label.trim().toLowerCase();
  const el = page.locator(selector);

  const targetIndex = await el.evaluate((selectEl, norm) => {
    const opts = Array.from((selectEl as HTMLSelectElement).options);
    // Acronym: first letter of each word, e.g. "Little Giant" → "lg"
    const acronym = (text: string) =>
      text.split(/[\s\-_]+/).map((w: string) => w[0]?.toLowerCase() ?? '').join('');

    return opts.findIndex((o) => {
      const t = o.text.trim().toLowerCase();
      return (
        t === norm ||                        // exact
        t.includes(norm) ||                  // option contains search
        norm.includes(t) ||                  // search contains option (e.g. "louisville" → "Louisville")
        acronym(o.text.trim()) === norm ||   // acronym: "LG" → "Little Giant"
        t.startsWith(norm) ||               // option starts with search
        norm.startsWith(t.slice(0, 4))      // search starts with first 4 chars of option
      );
    });
  }, normalized).catch(() => -1);

  if (targetIndex < 0) {
    console.warn(`  [WARN] No option matching "${label}" in ${selector}`);
    return;
  }

  // CDP keyboard events do NOT trigger the browser's native <select> key handling —
  // the C++ code that changes selectedIndex and fires change never runs via Playwright key dispatch.
  // Instead: set selectedIndex directly in JS, then fire both a native change event and a
  // jQuery trigger (BSI uses jQuery handlers that only fire via $.trigger, not raw dispatchEvent).
  const selectedText = await el.evaluate((selectEl: HTMLSelectElement, idx) => {
    selectEl.selectedIndex = idx;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    const $ = (window as any).jQuery;
    if ($) $(selectEl).trigger('change');
    return selectEl.options[idx]?.text ?? '(none)';
  }, targetIndex).catch(() => '(eval error)');
  console.log(`  [SELECT] ${selector} → "${selectedText}" (index ${targetIndex})`);

  await pause(delay);
}

// Fill Location ID + Brand + Type + Length + Description for a new/unknown serial.
// Uses Tab between fields and ArrowDown inside dropdowns — the exact keyboard flow
// Sets dropdowns via evaluate+jQuery (no Tab navigation needed) then fills Location ID last.
// Location ID is filled last because BSI's validation only fires on real keyboard input/blur,
// so we click into the field, fill it, then Tab out to trigger the green checkmark.
async function fillNewSerialFields(
  page: Page,
  record: LadderRecord,
  opts: AutomationOptions,
): Promise<void> {
  // 1. Brand
  await keyboardSelectDropdown(page, '#LadderBrand', expandAbbrev(BRAND_ABBREV, record.brand), opts.actionDelay);
  await pause(400);

  // 2. Type — its change event triggers the AJAX that populates Length options
  await keyboardSelectDropdown(page, '#WoLadType', expandAbbrev(TYPE_ABBREV, record.type), opts.actionDelay);
  await pause(400);

  // 3. Length — wait for AJAX to populate options after Type was set
  if (record.length && record.length !== '?') {
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('#LadderLength') as HTMLSelectElement | null;
        return sel != null && sel.options.length > 1;
      },
      { timeout: 8_000 },
    ).catch(() => console.warn('  [WARN] #LadderLength options did not load in time'));
    await keyboardSelectDropdown(page, '#LadderLength', record.length, opts.actionDelay);
    await pause(400);
  }

  // 4. Description — always "Ladder Repair"
  await keyboardSelectDropdown(page, '#WoLadDesc', 'Ladder Repair', opts.actionDelay);
  await pause(400);

  // 5. Location ID — filled last so BSI validation fires correctly.
  // Click the field, fill, then Tab out to trigger blur/change validation.
  const locField = page.getByRole('textbox', { name: 'Truck or Location ID' });
  if (await locField.isVisible().catch(() => false)) {
    await locField.click();
    await locField.fill(record.truckId);
    await locField.press('Tab');
    await pause(opts.actionDelay);
  }
}

// Find the most recently added #box-N element.
async function getLatestBoxSelector(page: Page): Promise<string> {
  const ids = await page.locator('[id^="box-"]').evaluateAll((els) =>
    els.map((el) => el.id),
  );
  if (ids.length === 0) throw new Error('No box elements found after clicking Add Box.');
  const nums = ids.map((id) => parseInt(id.replace('box-', ''), 10)).filter((n) => !isNaN(n));
  return `#box-${Math.max(...nums)}`;
}

// ── Duplicate detection ───────────────────────────────────────────────────────

// Check if a box for this serial number is already on the work order page.
async function isDuplicate(page: Page, serialNum: string): Promise<boolean> {
  const boxes = await page.locator('[id^="box-"]').all();
  for (const box of boxes) {
    const text = await box.innerText().catch(() => '');
    if (text.includes(serialNum)) return true;
  }
  return false;
}

// ── Serial number confirmation ─────────────────────────────────────────────────

type SerialKind = 'existing' | 'new';
type SerialOutcome = { kind: SerialKind } | { kind: 'not_found' };

async function confirmSerial(
  page: Page,
  serialNum: string,
  opts: AutomationOptions,
): Promise<SerialOutcome> {
  const serialField = page.getByRole('textbox', { name: 'Serial Number' });

  await serialField.click();
  await pause(opts.actionDelay);

  await serialField.fill(serialNum);
  await pause(opts.actionDelay);

  await serialField.press('Enter');
  await pause(opts.actionDelay);

  const deadline = Date.now() + opts.dropdownTimeout;

  while (Date.now() < deadline) {
    const autocompleteBtn = page.getByRole('button', { name: serialNum });
    const noResultBtn = page.getByRole('button', { name: 'No result, add serial number' });

    if (await autocompleteBtn.isVisible().catch(() => false)) {
      await serialField.press('ArrowDown');
      await pause(opts.actionDelay);
      await autocompleteBtn.press('Enter');
      console.log(`  Waiting for BSI to load ladder data from server...`);
      await pause(opts.serialApiDelay);
      await waitForNetworkIdle(page, opts.serialApiDelay * 2);
      return { kind: 'existing' };
    }
    if (await noResultBtn.isVisible().catch(() => false)) {
      await noResultBtn.click();
      await pause(opts.serialApiDelay);
      return { kind: 'new' };
    }
    await pause(300);
  }

  // Timed out — serial lookup produced no usable result
  return { kind: 'not_found' };
}

// Dismiss a BSI error popup — covers both Bootstrap modals (.modal.show) and
// SweetAlert2 dialogs (.swal2-popup), which BSI uses for "Part Number Duplicated" errors.
async function dismissBsiErrorModal(page: Page, delay: number): Promise<string> {
  // Selectors that might contain the OK button across both dialog types
  const candidates = [
    '.swal2-popup .swal2-confirm',
    '.swal2-popup button',
    '.modal.show button',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).filter({ hasText: /^ok$/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 1_200 });
      // Try to grab the message text from either dialog type
      const msg = await page.locator('.swal2-html-container, .swal2-content, .modal.show .modal-body')
        .first().innerText().catch(() => '');
      if (msg) console.warn(`  [BSI error] ${msg.trim()}`);
      await btn.click();
      await pause(delay);
      return msg;
    } catch { /* try next */ }
  }
  return '';
}

// Close the Product Selector modal and block until it disappears.
// Tries the "Close" button by visible text, then the header × button, then Escape.
async function ensureProdModalClosed(page: Page, delay: number): Promise<void> {
  console.log('  Closing product modal...');
  try {
    // Scope to the specific modal so we don't match other "Close" buttons on the page
    await page.locator('#AddPartNoModal').getByRole('button', { name: 'Close' }).click({ timeout: 3_000 });
    console.log('  Clicked Close.');
  } catch {
    try {
      await page.locator('#AddPartNoModal .btn-close').click({ timeout: 2_000 });
      console.log('  Clicked modal × button.');
    } catch {
      console.log('  Pressing Escape.');
      await page.keyboard.press('Escape');
    }
  }
  // Wait until the search field is gone before moving to the next ladder
  await page
    .getByRole('textbox', { name: 'Search for ID / Type / Part' })
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => console.log('  Warning: modal may still be visible after close attempt.'));
  await pause(delay);
}

// ── Best-match selection from #ResPno options ────────────────────────────────

interface PartOption { value: string; text: string }

function bestMatch(options: PartOption[], searchTerm: string): PartOption | undefined {
  const norm = searchTerm.trim().toLowerCase();
  // 1. Exact match (whole text equals search term)
  const exact = options.find((o) => o.text.trim().toLowerCase() === norm);
  if (exact) return exact;
  // 2. Text starts with the search term
  const starts = options.find((o) => o.text.trim().toLowerCase().startsWith(norm));
  if (starts) return starts;
  // 3. Text contains the search term
  const contains = options.find((o) => o.text.trim().toLowerCase().includes(norm));
  if (contains) return contains;
  // 4. Fallback — first option
  return options[0];
}

// ── Part entry ────────────────────────────────────────────────────────────────

async function addPart(
  page: Page,
  part: PartEntry,
  isLast: boolean,
  opts: AutomationOptions,
): Promise<PartResult> {
  const { searchTerm, quantity } = part;
  try {
    const searchField = page.getByRole('textbox', { name: 'Search for ID / Type / Part' });

    // Ensure the modal is fully open before interacting
    await searchField.waitFor({ state: 'visible', timeout: opts.dropdownTimeout });

    // Click to focus, then type character-by-character so BSI's keydown
    // handlers fire and trigger the search — .fill() pastes silently and
    // the app never sees the keystrokes.
    await searchField.click({ clickCount: 3 }); // select-all clears any leftover text
    await pause(300);
    await searchField.pressSequentially(searchTerm, { delay: 80 });
    await pause(opts.actionDelay);


    // Wait for #ResPno to populate with at least one valid option
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('#ResPno') as HTMLSelectElement | null;
        return sel != null && Array.from(sel.options).some((o) => o.value !== '' && o.value !== '0');
      },
      { timeout: opts.dropdownTimeout },
    ).catch(async () => {
      // Log what BSI actually put in #ResPno so we can debug
      const opts2 = await page.locator('#ResPno option').evaluateAll(
        (els) => (els as HTMLOptionElement[]).map((o) => `"${o.text}" (${o.value})`),
      ).catch(() => []);
      console.log(`  #ResPno options after search: [${opts2.join(', ') || 'none'}]`);
      throw new Error(`Timeout waiting for #ResPno after searching "${searchTerm}"`);
    });
    await pause(800); // let all options finish loading

    const options = await page.locator('#ResPno option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[])
        .filter((o) => o.value !== '' && o.value !== '0')
        .map((o) => ({ value: o.value, text: o.text.trim() })),
    );

    if (options.length === 0) {
      return { searchTerm, status: 'not_found', message: 'No options in part dropdown' };
    }

    // Find the best match and how far down the list it is
    const match = bestMatch(options, searchTerm);
    if (!match) {
      return { searchTerm, status: 'not_found', message: 'Could not match any option' };
    }
    const matchIndex = options.findIndex((o) => o.value === match.value);
    // Tab lands focus on #ResPno. First ArrowDown selects item 0, second selects item 1, etc.
    const arrowPresses = matchIndex >= 0 ? matchIndex + 1 : 1;

    if (options.length > 1) {
      console.log(
        `  Part "${searchTerm}": ${options.length} options — navigating to "${match.text}" (position ${matchIndex + 1})`,
      );
    }

    // Tab moves focus from the search field into the #ResPno select.
    // Then ArrowDown navigates to the best match, Enter confirms.
    await searchField.press('Tab');
    await pause(400);
    for (let i = 0; i < arrowPresses; i++) {
      await page.locator('#ResPno').press('ArrowDown');
      await pause(300);
    }
    await page.locator('#ResPno').press('Enter');
    await pause(opts.actionDelay);

    // Qty field now has focus with value 1.
    // Only interact if we need a different quantity.
    if (quantity > 1) {
      const qtyField = page.getByRole('textbox', { name: '1', exact: true });
      await qtyField.dblclick();
      await pause(400);
      await qtyField.fill(String(quantity));
      await pause(opts.actionDelay);
    }

    if (isLast) {
      await page.getByRole('button', { name: 'Add & Close' }).click();
      const errMsg = await dismissBsiErrorModal(page, opts.actionDelay);
      if (errMsg.toLowerCase().includes('duplicat')) {
        // BSI rejected the part — modal may already be closed; ensure clean state then bail
        await ensureProdModalClosed(page, opts.actionDelay).catch(() => {});
        return { searchTerm, status: 'error', message: `BSI rejected (duplicate): ${errMsg.trim()}` };
      }
      await pause(opts.serialApiDelay);
      await waitForNetworkIdle(page, opts.serialApiDelay * 2);
    } else {
      await page.getByRole('button', { name: 'Add Another' }).click();
      const errMsg = await dismissBsiErrorModal(page, opts.actionDelay);
      if (errMsg.toLowerCase().includes('duplicat')) {
        // BSI rejected — ensure product modal is closed so the next part can try fresh
        await ensureProdModalClosed(page, opts.actionDelay).catch(() => {});
        return { searchTerm, status: 'error', message: `BSI rejected (duplicate): ${errMsg.trim()}` };
      }
      await pause(opts.actionDelay);
    }

    return {
      searchTerm,
      status: 'success',
      selectedOption: `${match.text} (${match.value})`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await ensureProdModalClosed(page, opts.actionDelay);
    if (msg.includes('Timeout') || msg.includes('waiting for')) {
      return { searchTerm, status: 'not_found', message: 'Part search returned no options' };
    }
    return { searchTerm, status: 'error', message: msg };
  }
}

// ── Pass 1: add the ladder box ────────────────────────────────────────────────

// Returns the box selector string on success, null on skip/duplicate/error.
async function addLadderBox(
  page: Page,
  record: LadderRecord,
  opts: AutomationOptions,
): Promise<{ boxSel: string | null; status: LadderResult['status']; errorMsg?: string }> {
  const { serialNum } = record;
  try {
    if (await isDuplicate(page, serialNum)) {
      console.log(`  Skipping SN ${serialNum} — already on this work order.`);
      return { boxSel: null, status: 'duplicate', errorMsg: 'Already on this work order' };
    }

    const outcome = await confirmSerial(page, serialNum, opts);

    if (outcome.kind === 'not_found') {
      // BSI didn't return this serial — add it as new and fill all fields from CSV.
      console.log(`  SN ${serialNum} not in BSI — adding as new.`);
    } else {
      console.log(`  Serial ${outcome.kind === 'new' ? '(new)' : '(found)'}`);
    }

    if (outcome.kind === 'existing') {
      // BSI auto-populated all fields from its database.
      // Only fill in anything that's still blank (edge case).
      await fillIfEmpty(page, 'Truck or Location ID', record.truckId, opts.actionDelay);
      await selectIfEmpty(page, '#LadderBrand', expandAbbrev(BRAND_ABBREV, record.brand), opts.actionDelay);
      await selectIfEmpty(page, '#WoLadType',   expandAbbrev(TYPE_ABBREV,  record.type),  opts.actionDelay);
      await selectIfEmpty(page, '#LadderLength', record.length, opts.actionDelay);
      await selectIfEmpty(page, '#WoLadDesc', 'Ladder Repair', opts.actionDelay);
    } else {
      // New or not-found serial — BSI fields are blank and require keyboard navigation
      // for validation (Tab between fields, ArrowDown inside dropdowns).
      await fillNewSerialFields(page, record, opts);
    }

    await page.getByRole('button', { name: 'Add Box' }).click();
    await pause(opts.actionDelay * 2);

    const boxSel = await getLatestBoxSelector(page);
    return { boxSel, status: 'success' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await screenshot(page, serialNum).catch(() => undefined);
    return { boxSel: null, status: 'error', errorMsg: msg };
  }
}

// ── Pass 2: add parts to an existing box ─────────────────────────────────────

// parts parameter lets callers pass a subset (for diff/re-run mode).
async function addPartsToBox(
  page: Page,
  parts: import('./types.js').PartEntry[],
  serialNum: string,
  boxSel: string,
  opts: AutomationOptions,
): Promise<PartResult[]> {
  const partResults: PartResult[] = [];

  if (parts.length === 0) return partResults;

  // Verify the box selector resolves to the expected serial before touching anything.
  const boxNum = boxSel.replace('#box-', '');
  const actualSerial = await page.locator(`#boxserialnumberh-${boxNum}`)
    .inputValue().catch(() => '?');
  if (actualSerial !== serialNum) {
    console.warn(`  [BOX MISMATCH] ${boxSel} has SN="${actualSerial}" but expected "${serialNum}" — aborting part add`);
    return parts.map(p => ({ searchTerm: p.searchTerm, status: 'error' as const, message: 'Box selector mismatch' }));
  }
  console.log(`  [BOX OK] ${boxSel} → SN="${actualSerial}"`);

  // Before opening the product modal, read what parts are already in this box
  // so we never add the same part number twice to the same box.
  const existingInBox = await page.locator(`${boxSel} tr`).evaluateAll((rows) =>
    rows.map(r => (r as HTMLElement).innerText.trim()).filter(t => /^\d+\s+\S+/.test(t))
       .map(t => { const m = t.match(/^\d+\s+(\S+)/); return m ? m[1].toUpperCase() : ''; })
       .filter(Boolean),
  ).catch(() => [] as string[]);
  const inBoxSet = new Set(existingInBox);
  if (inBoxSet.size > 0) console.log(`  [BOX PARTS] already has: ${[...inBoxSet].join(', ')}`);

  // Filter out parts already in THIS box using the same fuzzy logic as the diff:
  // exact match OR one string contains the other (e.g. "S375" matched by "SLS375").
  const partsToAdd = parts.filter(p => {
    const term = p.searchTerm.toLowerCase();
    const alreadyInBox = [...inBoxSet].some(existing => {
      const e = existing.toLowerCase();
      return e === term || e.includes(term) || term.includes(e);
    });
    if (alreadyInBox) {
      console.log(`  [SKIP] "${p.searchTerm}" already in ${boxSel} — skipping`);
      partResults.push({ searchTerm: p.searchTerm, status: 'skipped', message: 'Already in this box' });
      return false;
    }
    return true;
  });

  if (partsToAdd.length === 0) return partResults;

  try {
    await page.locator(boxSel).getByRole('button', { name: 'Add Product' }).click();
    await pause(opts.actionDelay);

    for (let i = 0; i < partsToAdd.length; i++) {
      const isLast = i === partsToAdd.length - 1;
      const result = await addPart(page, partsToAdd[i], isLast, opts);
      partResults.push(result);
      if (result.status !== 'success') {
        console.warn(`  [WARN] Part "${result.searchTerm}" → ${result.status}: ${result.message ?? ''}`);
        if (!isLast) {
          const searchVisible = await page
            .getByRole('textbox', { name: 'Search for ID / Type / Part' })
            .isVisible()
            .catch(() => false);
          if (!searchVisible) {
            await page.locator(boxSel).getByRole('button', { name: 'Add Product' }).click().catch(() => {});
            await pause(opts.actionDelay);
          }
        }
      }
    }

    // Safety net — close modal if still open after a failed part
    const searchStillOpen = await page
      .getByRole('textbox', { name: 'Search for ID / Type / Part' })
      .isVisible()
      .catch(() => false);
    if (searchStillOpen) {
      await ensureProdModalClosed(page, opts.actionDelay);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await ensureProdModalClosed(page, opts.actionDelay);
    partResults.push({ searchTerm: '(unknown)', status: 'error', message: msg });
  }
  return partResults;
}

// ── Browser launch + page detection ───────────────────────────────────────────

export async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  mainPage: Page;
}> {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--start-maximized',
      '--disable-extensions',           // prevent extensions from interfering with CDP
      '--disable-background-networking', // reduce unnecessary background traffic
    ],
  });
  const context = await browser.newContext({
    viewport: null, // let the OS window size dictate the viewport
  });
  const mainPage = await context.newPage();
  await mainPage.goto('https://www.bsiwebapp.com/login/');
  return { browser, context, mainPage };
}

export async function findWorkOrderPage(context: BrowserContext, mainPage: Page): Promise<Page> {
  const pages = context.pages();
  // Any page other than the main page counts — popups start as about:blank while loading
  const others = pages.filter((p) => p !== mainPage);
  if (others.length > 0) {
    // Prefer a page with bsiwebapp in the URL if it has already loaded
    const bsiPage = others.find((p) => p.url().includes('bsiwebapp.com'));
    return bsiPage ?? others[others.length - 1];
  }
  throw new Error('No popup yet.');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runAutomation(
  records: LadderRecord[],
  workPage: Page,
  opts: AutomationOptions,
): Promise<LadderResult[]> {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  // Auto-accept any native browser alert/confirm BSI shows (e.g. duplicate part warnings).
  workPage.on('dialog', async (dialog) => {
    console.warn(`  [BSI alert] ${dialog.message()}`);
    await dialog.accept();
  });

  const results: LadderResult[] = [];

  for (const record of records) {
    await checkPaused();
    console.log(`\nProcessing SN ${record.serialNum}...`);

    // Step 1: add the ladder box
    const { boxSel, status, errorMsg } = await addLadderBox(workPage, record, opts);

    if (!boxSel) {
      // Skipped, duplicate, or error — no box to add parts to
      const icon = status === 'duplicate' ? '=' : '✗';
      console.log(`  ${icon} SN ${record.serialNum}: ${status}`);
      results.push({
        serialNum: record.serialNum,
        status,
        partsTotal: record.parts.length,
        partsOk: 0,
        partResults: [],
        ...(errorMsg ? { errorMsg } : {}),
      });
      await pause(opts.pauseBetweenLadders);
      continue;
    }

    // Step 2: add parts to the box we just created
    let partResults: PartResult[] = [];
    if (record.parts.length > 0) {
      partResults = await addPartsToBox(workPage, record.parts, record.serialNum, boxSel, opts);
    }

    const partsOk = partResults.filter((p) => p.status === 'success').length;
    const allOk = record.parts.length === 0 || partsOk === record.parts.length;
    const finalStatus: LadderResult['status'] = allOk
      ? 'success'
      : partsOk > 0
      ? 'partial'
      : record.parts.length > 0
      ? 'error'
      : 'success';

    const icon = finalStatus === 'success' ? '✓' : finalStatus === 'partial' ? '~' : '✗';
    console.log(`  ${icon} SN ${record.serialNum}: ${finalStatus} (${partsOk}/${record.parts.length} parts)`);

    results.push({
      serialNum: record.serialNum,
      status: finalStatus,
      partsTotal: record.parts.length,
      partsOk,
      partResults,
    });

    await pause(opts.pauseBetweenLadders);
  }

  return results;
}

// ── Scrape existing work order ────────────────────────────────────────────────

export async function scrapeWorkOrderBoxes(
  page: Page,
): Promise<import('./types.js').WorkOrderBox[]> {
  const boxes = await page.locator('[id^="box-"]').all();
  const result: import('./types.js').WorkOrderBox[] = [];

  for (const box of boxes) {
    const id = await box.getAttribute('id') ?? '';
    const num = id.replace('box-', '');
    if (!num || isNaN(Number(num))) continue;

    // Serial number from the dedicated read-only input
    const serial = await box.locator(`#boxserialnumberh-${num}`)
      .inputValue()
      .catch(() => '');
    if (!serial) continue;

    // Part numbers from table rows — each data row: "DBID PartNum Description..."
    const rows = await box.locator('tr').all();
    const partNums: string[] = [];
    for (const row of rows) {
      const text = (await row.innerText().catch(() => '')).trim();
      const match = text.match(/^\d+\s+(\S+)/);
      if (match?.[1]) partNums.push(match[1]);
    }

    // Scrape total repair cost shown by BSI for this box.
    // BSI renders the box total as a dollar amount in the box footer.
    // We grab all currency values from the box text and take the last one,
    // which is typically the grand total (parts are listed before it).
    let totalCost: number | undefined;
    try {
      const boxText = await box.innerText().catch(() => '');
      // Match "$123.45" or "123.45" patterns (BSI may or may not include the $)
      const dollarMatches = boxText.match(/\$\s*[\d,]+\.?\d*/g);
      if (dollarMatches && dollarMatches.length > 0) {
        const amounts = dollarMatches.map(m => parseFloat(m.replace(/[$,\s]/g, '')));
        const validAmounts = amounts.filter(n => !isNaN(n) && n > 0);
        if (validAmounts.length > 0) {
          // Last dollar amount is usually the box total
          totalCost = validAmounts[validAmounts.length - 1];
        }
      }
    } catch { /* non-fatal */ }

    result.push({ selector: `#${id}`, serialNum: serial, partNums, totalCost });
  }

  return result;
}

// ── Diff CSV vs work order ────────────────────────────────────────────────────

export function diffCsvVsWorkOrder(
  records: import('./types.js').LadderRecord[],
  boxes: import('./types.js').WorkOrderBox[],
): import('./types.js').DiffResult {
  const missingBoxes: import('./types.js').LadderRecord[] = [];
  const existingWithGaps: import('./types.js').DiffItemWithGaps[] = [];
  const alreadyComplete: import('./types.js').LadderRecord[] = [];

  for (const record of records) {
    const existing = boxes.find((b) => b.serialNum === record.serialNum);

    if (!existing) {
      missingBoxes.push(record);
      continue;
    }

    const existingLower = existing.partNums.map((p) => p.toLowerCase());
    // Fuzzy match: a CSV search term is "present" if any existing part code is an exact match
    // OR one string contains the other (e.g. CSV "S375" is matched by BSI code "SLS375").
    const isPresent = (searchTerm: string) => {
      const t = searchTerm.toLowerCase();
      return existingLower.some((e) => e === t || e.includes(t) || t.includes(e));
    };
    const missingParts = record.parts.filter((p) => !isPresent(p.searchTerm));
    const presentParts = record.parts.filter((p) => isPresent(p.searchTerm)).map((p) => p.searchTerm);

    if (missingParts.length === 0) {
      alreadyComplete.push(record);
    } else {
      existingWithGaps.push({
        record,
        boxSelector: existing.selector,
        missingParts,
        presentParts,
      });
    }
  }

  return { missingBoxes, existingWithGaps, alreadyComplete };
}

// ── Run automation with diff result ──────────────────────────────────────────

export async function runAutomationWithDiff(
  diff: import('./types.js').DiffResult,
  mode: 'all' | 'boxes-only',
  workPage: Page,
  opts: AutomationOptions,
): Promise<LadderResult[]> {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  workPage.on('dialog', async (dialog) => {
    console.warn(`  [BSI alert] ${dialog.message()}`);
    await dialog.accept();
  });

  const results: LadderResult[] = [];

  // ── Already complete: skip entirely ──────────────────────────────────────
  for (const record of diff.alreadyComplete) {
    console.log(`  = SN ${record.serialNum}: already complete — skipped`);
    results.push({
      serialNum: record.serialNum,
      status: 'skipped',
      partsTotal: record.parts.length,
      partsOk: record.parts.length,
      partResults: record.parts.map((p) => ({ searchTerm: p.searchTerm, status: 'success' as const })),
    });
  }

  // ── Missing boxes: add in full ────────────────────────────────────────────
  for (const record of diff.missingBoxes) {
    await checkPaused();
    console.log(`\nAdding new box — SN ${record.serialNum}...`);
    const { boxSel, status, errorMsg } = await addLadderBox(workPage, record, opts);
    if (!boxSel) {
      console.log(`  ✗ SN ${record.serialNum}: ${status}`);
      results.push({ serialNum: record.serialNum, status, partsTotal: record.parts.length, partsOk: 0, partResults: [], ...(errorMsg ? { errorMsg } : {}) });
      await pause(opts.pauseBetweenLadders);
      continue;
    }
    let partResults: PartResult[] = [];
    if (record.parts.length > 0) {
      partResults = await addPartsToBox(workPage, record.parts, record.serialNum, boxSel, opts);
    }
    const partsOk = partResults.filter((p) => p.status === 'success').length;
    const allOk = record.parts.length === 0 || partsOk === record.parts.length;
    const finalStatus: LadderResult['status'] = allOk ? 'success' : partsOk > 0 ? 'partial' : 'error';
    console.log(`  ✓ SN ${record.serialNum}: ${finalStatus} (${partsOk}/${record.parts.length} parts)`);
    results.push({ serialNum: record.serialNum, status: finalStatus, partsTotal: record.parts.length, partsOk, partResults });
    await waitForNetworkIdle(workPage, opts.serialApiDelay);
    await pause(opts.pauseBetweenLadders);
  }

  // ── Existing with gaps ────────────────────────────────────────────────────
  for (const { record, boxSelector, missingParts } of diff.existingWithGaps) {
    await checkPaused();
    if (mode === 'boxes-only') {
      // User chose to skip existing boxes
      console.log(`  - SN ${record.serialNum}: box exists — skipped (boxes-only mode)`);
      results.push({
        serialNum: record.serialNum,
        status: 'skipped',
        partsTotal: record.parts.length,
        partsOk: record.parts.length - missingParts.length,
        partResults: record.parts.map((p) =>
          missingParts.some((m) => m.searchTerm === p.searchTerm)
            ? { searchTerm: p.searchTerm, status: 'skipped' as const, message: 'skipped (boxes-only mode)' }
            : { searchTerm: p.searchTerm, status: 'success' as const },
        ),
      });
      continue;
    }

    // mode === 'all': add only the missing parts
    console.log(`\nAdding ${missingParts.length} missing part(s) to existing box — SN ${record.serialNum}...`);
    const partResults = await addPartsToBox(workPage, missingParts, record.serialNum, boxSelector, opts);
    const partsOk = partResults.filter((p) => p.status === 'success').length;
    const totalOk = (record.parts.length - missingParts.length) + partsOk;
    const finalStatus: LadderResult['status'] =
      totalOk === record.parts.length ? 'success' : totalOk > 0 ? 'partial' : 'error';
    console.log(`  ${finalStatus === 'success' ? '✓' : '~'} SN ${record.serialNum}: ${finalStatus}`);
    results.push({
      serialNum: record.serialNum,
      status: finalStatus,
      partsTotal: record.parts.length,
      partsOk: totalOk,
      partResults: [
        ...record.parts
          .filter((p) => !missingParts.some((m) => m.searchTerm === p.searchTerm))
          .map((p) => ({ searchTerm: p.searchTerm, status: 'success' as const })),
        ...partResults,
      ],
    });
    await waitForNetworkIdle(workPage, opts.serialApiDelay);
    await pause(opts.pauseBetweenLadders);
  }

  return results;
}
