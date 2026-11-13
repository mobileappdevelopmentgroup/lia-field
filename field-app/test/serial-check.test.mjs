// "N/A" is not a serial (2026-11-12). A lanyard with no serial went up as
// "Na"; the server keys an item on its serial, so the next item saved that way
// would have been recorded against the lanyard. Ladders and fall protection
// both refuse the words people type to mean "there isn't one", and a real
// serial still goes through. Drives the real page. Run with `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 700 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);

// The rule itself.
const verdicts = await p.evaluate(() => [
  'N/A', 'n/a', 'N.A.', 'Na', ' na ', 'none', 'Unknown', 'No Serial', 'no s/n', 'TBD',
  '-', '?', '000', 'xxx',
  '1719760', 'FP161350', 'H-9001', 'NA-1234', 'NAS22', 'X1', '0012',
].map(s => [s, LiaSerialCheck.isPlaceholder(s)]));
ok('placeholders are refused, real serials are not', verdicts, [
  ['N/A', true], ['n/a', true], ['N.A.', true], ['Na', true], [' na ', true], ['none', true],
  ['Unknown', true], ['No Serial', true], ['no s/n', true], ['TBD', true],
  ['-', true], ['?', true], ['000', true], ['xxx', true],
  ['1719760', false], ['FP161350', false], ['H-9001', false], ['NA-1234', false],
  ['NAS22', false], ['X1', false], ['0012', false],
]);
ok('a blank field is left to the existing prompt', await p.evaluate(() => LiaSerialCheck.problem('  ')), null);

// ── Ladders ──────────────────────────────────────────────────────────────────
await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="ladder"]').catch(() => {});
await p.waitForTimeout(300);
const ladders = () => p.evaluate(() => (_job.ladders || []).length);

await p.fill('#fi-serial', 'N/A');
await p.click('#btn-add-ladder'); await p.waitForTimeout(150);
ok('a ladder typed as N/A is not added', await ladders(), 0);
ok('and the tech is told why',
   await p.$eval('#entry-notice', e => e.offsetParent !== null && /not a serial number/.test(e.textContent)), true);
ok('the serial stays in the box to be corrected', await p.$eval('#fi-serial', e => e.value), 'N/A');

await p.fill('#fi-serial', '1719760');
await p.click('#btn-add-ladder'); await p.waitForTimeout(150);
ok('a real serial is added', await ladders(), 1);

// Editing a ladder into N/A is refused too.
await p.evaluate(() => { _editingIdx = 0; setEditMode(true); $('fi-serial').value = 'none'; saveEdits(); });
ok('an edit to "none" is not saved', await p.evaluate(() => _job.ladders[0].serialNum), '1719760');
await p.evaluate(() => cancelEdit());

// ── Fall protection ──────────────────────────────────────────────────────────
await p.reload(); await p.waitForTimeout(400);
await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);
const items = () => p.evaluate(() => (_job.items || []).length);

await p.click('#fp-btn-new'); await p.waitForTimeout(200);
await p.fill('#fpf-serial', 'n/a');
await p.selectOption('#fpf-equipment_type', 'lanyard'); await p.waitForTimeout(150);
await p.click('#fp-btn-done-edit'); await p.waitForTimeout(150);
await p.click('#fp-btn-save'); await p.waitForTimeout(250);
ok('an item typed as n/a is not recorded', await items(), 0);
ok('the fields reopen to fix it', await p.evaluate(() => $('fp-edit-form').style.display !== 'none'), true);
ok('and the hint says what to use instead',
   await p.$eval('#fp-hint', e => /not a serial number/.test(e.textContent) && /tag/.test(e.textContent)), true);

// With a tag on it, the hint names the tag's number.
await p.evaluate(() => { _fpItem.tag_label = 'FP161350'; fpSave(); });
ok('with a tag on the item, the hint offers its number',
   await p.$eval('#fp-hint', e => /FP161350/.test(e.textContent)), true);

await p.fill('#fpf-serial', 'FP161350');
await p.click('#fp-btn-done-edit'); await p.waitForTimeout(150);
await p.click('#fp-btn-save'); await p.waitForTimeout(250);
ok('the tag number goes through', await items(), 1);
ok('as the serial', await p.evaluate(() => _job.items[0].serial_num || _job.items[0].serial_raw), 'FP161350');

// Tap & pass refuses it the same way.
ok('Tap & pass will not pass an N/A item',
   await p.evaluate(() => fpBatchMissing({ equipment_type: 'lanyard', serial_raw: 'N/A' })), 'not a serial number');

ok('no page errors', errs, []);
await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
