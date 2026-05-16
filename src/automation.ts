import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  AutomationOptions,
  LadderRecord,
  LadderResult,
  PartEntry,
  PartResult,
} from './types.js';

const LOGS_DIR = path.join(process.cwd(), 'logs');

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

// Select a <select> only when it has no meaningful selection yet.
async function selectIfEmpty(
  page: Page,
  selector: string,
  label: string,
  delay: number,
): Promise<void> {
  if (!label) return;
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
    // Click to focus, then type character-by-character so BSI's keydown
    // handlers fire and trigger the search — .fill() pastes silently and
    // the app never sees the keystrokes.
    const searchField = page.getByRole('textbox', { name: 'Search for ID / Type / Part' });
    await searchField.click();
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
    );
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
      await pause(opts.serialApiDelay);
      await waitForNetworkIdle(page, opts.serialApiDelay * 2);
    } else {
      await page.getByRole('button', { name: 'Add Another' }).click();
      await pause(opts.actionDelay);
    }

    return {
      searchTerm,
      status: 'success',
      selectedOption: `${match.text} (${match.value})`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const closeBtn = page.getByRole('button', { name: 'Add & Close' });
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click().catch(() => undefined);
      await pause(opts.actionDelay);
    }
    if (msg.includes('Timeout') || msg.includes('waiting for')) {
      return { searchTerm, status: 'not_found', message: 'Part search returned no options' };
    }
    return { searchTerm, status: 'error', message: msg };
  }
}

// ── Ladder entry ──────────────────────────────────────────────────────────────

async function fillLadder(
  page: Page,
  record: LadderRecord,
  opts: AutomationOptions,
): Promise<LadderResult> {
  const partResults: PartResult[] = [];
  const { serialNum } = record;

  try {
    // 0. Duplicate check — skip if this serial is already on the work order
    if (await isDuplicate(page, serialNum)) {
      console.log(`  Skipping SN ${serialNum} — already on this work order.`);
      return {
        serialNum,
        status: 'duplicate',
        partsTotal: record.parts.length,
        partsOk: 0,
        partResults: [],
        errorMsg: 'Duplicate: serial number already exists on this work order',
      };
    }

    // 1. Serial number lookup
    const outcome = await confirmSerial(page, serialNum, opts);

    if (outcome.kind === 'not_found') {
      console.log(`  Serial ${serialNum} not found — skipping.`);
      return {
        serialNum,
        status: 'skipped',
        partsTotal: record.parts.length,
        partsOk: 0,
        partResults: [],
        errorMsg: 'Serial number lookup timed out — not found in BSI or no response',
      };
    }

    console.log(
      `  Serial ${outcome.kind === 'new' ? '(new — will fill all fields)' : '(found — auto-filled fields kept)'}`,
    );

    // 2. Fill only fields that BSI left empty (green checkmark = already valid)
    await fillIfEmpty(page, 'Truck or Location ID', record.truckId, opts.actionDelay);

    await selectIfEmpty(page, '#LadderBrand', record.brand, opts.actionDelay);
    await selectIfEmpty(page, '#WoLadType', record.type, opts.actionDelay);
    await selectIfEmpty(page, '#LadderLength', record.length, opts.actionDelay);
    await selectIfEmpty(page, '#WoLadDesc', record.desc, opts.actionDelay);

    // 3. Commit the box
    await page.getByRole('button', { name: 'Add Box' }).click();
    await pause(opts.actionDelay * 2); // box creation takes a moment

    // 4. Find the new box
    const boxSel = await getLatestBoxSelector(page);

    // 5. Add parts
    if (record.parts.length > 0) {
      await page.locator(boxSel).getByRole('button', { name: 'Add Product' }).click();
      await pause(opts.actionDelay);

      for (let i = 0; i < record.parts.length; i++) {
        const result = await addPart(page, record.parts[i], i === record.parts.length - 1, opts);
        partResults.push(result);
        if (result.status !== 'success') {
          console.warn(
            `  [WARN] Part "${result.searchTerm}" → ${result.status}: ${result.message ?? ''}`,
          );
        }
      }
    }

    const partsOk = partResults.filter((p) => p.status === 'success').length;
    const allOk = record.parts.length === 0 || partsOk === record.parts.length;
    return {
      serialNum,
      status: allOk ? 'success' : partsOk > 0 ? 'partial' : 'error',
      partsTotal: record.parts.length,
      partsOk,
      partResults,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await screenshot(page, serialNum).catch(() => undefined);
    return {
      serialNum,
      status: 'error',
      partsTotal: record.parts.length,
      partsOk: partResults.filter((p) => p.status === 'success').length,
      partResults,
      errorMsg: msg,
    };
  }
}

// ── Browser launch + page detection ───────────────────────────────────────────

export async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  mainPage: Page;
}> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
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

  const results: LadderResult[] = [];

  for (const record of records) {
    console.log(`\nProcessing SN ${record.serialNum}...`);
    const result = await fillLadder(workPage, record, opts);
    results.push(result);

    const icon = result.status === 'success' ? '✓' : result.status === 'partial' ? '~' : '✗';
    console.log(
      `  ${icon} SN ${record.serialNum}: ${result.status} ` +
      `(${result.partsOk}/${result.partsTotal} parts)`,
    );

    if (result.status !== 'error') {
      await pause(opts.pauseBetweenLadders);
    }
  }

  return results;
}
