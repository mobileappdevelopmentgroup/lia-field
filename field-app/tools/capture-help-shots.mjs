// Captures the screenshots used by the in-app help.
//
//   node field-app/tools/capture-help-shots.mjs
//
// Writes PNGs into field-app/help/img/, one per `shot()` referenced in
// field-app/js/help.js. Re-run it whenever the UI moves.
//
// ── Why these are generated rather than drawn ───────────────────────────────
// The obvious way to build a picture walkthrough is to take a screenshot once
// and paint an arrow on it. That arrow is correct until somebody moves a
// button, and from then on the manual points confidently at the wrong thing —
// which is worse than no manual, because a tech trusts it.
//
// So the highlight is applied to the LIVE ELEMENT by selector, immediately
// before the shot is taken. If the element moves, the ring moves with it. If it
// is renamed or deleted, this script fails loudly rather than producing a
// picture with the ring in the old place. The callout cannot drift out of sync
// with the app because it is drawn by the app.
//
// The app is driven over file:// exactly as fp-capture.test.mjs does, so there
// is no server and no config: a local-only build, which is what a first-run
// phone looks like anyway.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'field-app', 'help', 'img');
fs.mkdirSync(OUT, { recursive: true });

// A tall, narrow phone — the device the app is actually used on. Screenshots
// taken at desktop width would show a layout no tech ever sees.
const VIEWPORT = { width: 390, height: 844 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', e => errs.push(e.message));

// Headless Chromium has no NFC, so the app correctly hides Tap and Tap-through —
// which would leave the manual describing four ways in over a picture of three.
// A stand-in plugin is installed before any page script runs, so the pictures
// show what a real handset shows. Nothing is ever read through it.
await page.addInitScript(() => {
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { NFC: {
      startScan: () => Promise.reject(new Error('capture stub')),
      cancelScan: () => Promise.resolve(),
      writeNDEF: () => Promise.resolve(),
      addListener: () => Promise.resolve({ remove() {} }),
    } },
  };
});

await page.goto('file://' + ROOT + '/field-app/index.html');
await page.waitForTimeout(400);

// The ring. Injected once, applied per shot, and always removed afterwards so
// two highlights can never stack up in one picture.
await page.addStyleTag({ content: `
  .__shot-ring {
    position: relative !important;
    outline: 3px solid #ff9500 !important;
    outline-offset: 2px !important;
    border-radius: 10px !important;
    box-shadow: 0 0 0 9999px rgba(0,0,0,.28) !important;
    z-index: 9999 !important;
  }
  /* The caret blink and the tap-through pulse both make a screenshot
     non-deterministic — the same state photographs differently run to run. */
  *, *::before, *::after {
    animation-play-state: paused !important;
    caret-color: transparent !important;
    transition: none !important;
  }
`});

let count = 0;
const failures = [];

async function shot(name, selector) {
  if (selector) {
    const found = await page.$(selector);
    if (!found) {
      // Loud, not silent. A missing selector means the UI moved and this
      // walkthrough is now describing something that is not there.
      failures.push(`${name}: no element matches ${selector}`);
      return;
    }
    await page.evaluate(s => {
      const el = document.querySelector(s);
      if (el) el.classList.add('__shot-ring');
    }, selector);
  }
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  if (selector) {
    await page.evaluate(() => {
      document.querySelectorAll('.__shot-ring').forEach(e => e.classList.remove('__shot-ring'));
    });
  }
  count++;
  console.log('  ✓ ' + name + '.png');
}

console.log('Capturing help screenshots…');

// ── Sign-in and first download ───────────────────────────────────────────────
// Forced, because a local-only build never shows them — and they are the first
// two screens a new tech meets.
await page.evaluate(() => goScreen('auth'));
await page.waitForTimeout(150);
await shot('auth', '#btn-sign-in');

await page.evaluate(() => {
  goScreen('sync');
  const f = document.getElementById('sync-fill');
  if (f) f.style.width = '62%';
  const m = document.getElementById('sync-msg');
  if (m) m.textContent = '1,068 of 1,724 items';
});
await page.waitForTimeout(150);
await shot('sync', '#btn-sync-start');

// ── The job list ─────────────────────────────────────────────────────────────
await page.evaluate(() => { goScreen('jobs'); renderJobList(); });
await page.waitForTimeout(200);
await shot('jobs', '#btn-new-job');

// ── A ladder job ─────────────────────────────────────────────────────────────
await page.click('#btn-new-job'); await page.waitForTimeout(150);
await page.click('.scope-opt[data-scope="ladder"]'); await page.waitForTimeout(300);
await page.fill('#job-name', 'Comcast Northern Tier');
await page.fill('#job-wo', 'WO-12345');
await page.fill('#fi-serial', '1509167');
await page.waitForTimeout(150);
await shot('ladder-entry', '#btn-scan');

// ── A fall protection job ────────────────────────────────────────────────────
await page.evaluate(() => { goScreen('jobs'); renderJobList(); });
await page.waitForTimeout(150);
await page.click('#btn-new-job'); await page.waitForTimeout(150);
await page.click('.scope-opt[data-scope="fall_protection"]'); await page.waitForTimeout(300);
// An empty job header photographs as placeholder text, which reads as an
// unfinished screen rather than as a job in progress.
await page.fill('#job-name', 'Comcast Northern Tier');
await page.fill('#job-wo', 'WO-12345');
await page.waitForTimeout(150);

// The four ways in. Nothing is ringed: the point of the picture is that there
// are four of them, not that one is special.
await shot('fp-input', null);

// A recognised item, shown read-only — what a tech sees on a tap that resolves.
await page.evaluate(() => {
  fpAdopt({
    serial_raw: 'FP158354', manufacturer: 'BUCKINGHAM', model: 'U69P98Q2',
    equipment_type: 'crane_lift_sling', item_type: 'Crane lift sling',
    description: 'Yellow web sling, 6 ft', lot_number: '9956',
    mfg_month: '4', mfg_year: '2023', last_inspected: '2025-08-22',
    nfc_tag_uid: '04A1B2C3',
  }, true);
});
await page.waitForTimeout(250);
await shot('fp-record', '#fp-record');

// The checklist, every answer sitting at passing.
await shot('fp-checks', '#fp-checks-panel');

// Removal from service, with the photo gate visible.
await page.evaluate(() => {
  const i = _fpChecks.findIndex(c => c.answer_style === 'pass_fail');
  if (i >= 0) {
    const segs = document.querySelectorAll('.fp-chk')[i].querySelectorAll('.fp-seg button');
    (_fpChecks[i].pass_answer ? segs[1] : segs[0]).click();
  }
});
await page.waitForTimeout(200);
await page.click('#fp-btn-save'); await page.waitForTimeout(300);
await shot('fp-condemn', '#fp-btn-photo');
await page.click('#fp-btn-cancel-condemn'); await page.waitForTimeout(200);

// ── Tap-through ──────────────────────────────────────────────────────────────
// NFC does not exist in headless Chromium, so the panel is shown directly. What
// the picture has to convey is the layout and the count, and both are real.
await page.evaluate(() => {
  _fpItem = null; _fpChecks = [];
  _fpBatch = { count: 7, recorded: [], last: {
    serial: 'FP158361', sub: 'Crane lift sling · BUCKINGHAM', flagged: false,
  }, lastAt: {}, stream: null, hint: 'Hold the phone to each item. Keep the screen on.' };
  fpRenderAll();
});
await page.waitForTimeout(250);
await shot('fp-batch', '#fp-batch-panel');

// ── A tag we do not know ─────────────────────────────────────────────────────
await page.evaluate(() => {
  // Clearing the run is not enough — the batch panel stays on screen until a
  // redraw, and it would sit behind this sheet in a picture about a SINGLE tap.
  _fpBatch = null;
  fpRenderAll();
  _fpLink = {
    tag: { url: 'https://acme-safety.example/tag/FP158354', uid: '04A1B2C3', foreign: true },
    state: 'nothing',
    result: { ok: false, code: 'HOST_NOT_ALLOWED', host: 'acme-safety.example',
              error: 'acme-safety.example is not a trusted source, so nothing was fetched from it.' },
    external: null,
  };
  fpOpenLinkSheet();
});
await page.waitForTimeout(250);
await shot('fp-link', '#fp-btn-link-inspect');
await page.evaluate(() => { fpCloseLinkSheet(); _fpLink = null; });

// ── Waiting to upload ────────────────────────────────────────────────────────
await page.evaluate(() => {
  fpReset();
  const el = document.getElementById('fp-pending');
  if (el) {
    el.style.display = '';
    el.className = 'fp-pending';
    el.textContent = '12 waiting to upload';
  }
});
await page.waitForTimeout(200);
await shot('pending', '#fp-pending');

await browser.close();

if (errs.length) {
  console.error('\nPage errors during capture:');
  errs.forEach(e => console.error('  ' + e));
}
if (failures.length) {
  console.error('\nThe UI has moved — these shots point at nothing:');
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error('\nFix the selector in this file, or the walkthrough now lies.');
  process.exit(1);
}
console.log(`\n${count} screenshots written to field-app/help/img/`);
