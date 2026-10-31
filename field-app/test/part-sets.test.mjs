// Favourite sets, and finding a part in a library of two thousand.
//
// Different sites use different parts, so a tech keeps more than one set of
// quick-tap buttons. "Main" is the library's own favourites — what the lead's
// published list writes into — and every other set is the tech's alone. A job
// remembers the set it was worked with.
//
// The library sheet's box both searches and adds: part numbers first, then a
// separate section for parts whose description matches.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let fails = 0;
const ok = (l, g, w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

await p.goto('file://' + ROOT + '/field-app/index.html');
await p.waitForTimeout(400);
await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="ladder"]').catch(() => {});
await p.waitForTimeout(300);

const grid = () => p.$$eval('#parts-grid .part-btn', e => e.map(x => x.textContent.replace(/\(\d+\)$/, '')));
const mainButtons = await grid();
ok('one set to start with, and no switcher', await p.$eval('#part-set-bar', e => e.children.length), 0);

// ── A new set ───────────────────────────────────────────────────────────────
await p.click('#btn-open-library'); await p.waitForTimeout(150);
ok('the library opens on the starred parts, not all of them',
   await p.$$eval('#lib-list .part-lib-row', e => e.length), mainButtons.length);
await p.click('#lib-set-new');
await p.fill('#lib-set-name', 'Ford plant');
await p.click('#lib-set-save'); await p.waitForTimeout(100);
ok('a new set is chosen and starts empty',
   await p.evaluate(() => [listPartSets().map(s => s.name), $('lib-set').selectedOptions[0].textContent, getFavoritedParts().length]),
   [['Main', 'Ford plant'], '★ Ford plant', 0]);

// ── Search ──────────────────────────────────────────────────────────────────
await p.fill('#new-lib-input', 'w44'); await p.waitForTimeout(100);
ok('typing filters to matching part numbers, starts-with first',
   await p.$$eval('#lib-list .part-lib-name', e => e[0].textContent), 'W44');
ok('under a Part number heading', await p.$$eval('#lib-list .lib-section', e => e.map(x => x.textContent)).then(h => h[0]), 'Part number');
await p.click('#lib-list .part-lib-row:first-of-type .star-btn').catch(async () =>
  p.click('#lib-list .part-lib-row .star-btn'));
await p.waitForTimeout(100);
ok('starring it puts it in this set only',
   await p.evaluate(() => [getFavoritedParts().map(x => x.name),
     getLibrary().find(x => x.name === 'W44').favorited]), [['W44'], false]);

await p.fill('#new-lib-input', 'wrap step'); await p.waitForTimeout(100);
const sections = await p.$$eval('#lib-list .lib-section', e => e.map(x => x.textContent));
ok('words that are not a part number find parts by description', sections, ['Description']);
ok('every word has to match',
   await p.$$eval('#lib-list .part-lib-desc', e => e.every(x => /wrap/i.test(x.textContent) && /step/i.test(x.textContent))), true);

await p.fill('#new-lib-input', 'A'); await p.waitForTimeout(100);
ok('a one-letter search is capped, and says there is more',
   await p.$$eval('#lib-list .lib-more', e => e.some(x => /more — keep typing/.test(x.textContent))), true);

await p.fill('#new-lib-input', 'ZZ-NEW-1'); await p.waitForTimeout(50);
ok('a part nobody has offers Add', await p.$eval('#lib-list', e => /Tap Add/.test(e.textContent)), true);
await p.click('#btn-add-lib-part'); await p.waitForTimeout(100);
ok('Add puts it in the library, still showing so it can be starred',
   await p.$$eval('#lib-list .part-lib-name', e => e.map(x => x.textContent)), ['ZZ-NEW-1']);

await p.click('#btn-close-library'); await p.waitForTimeout(100);
ok('the buttons are the new set', await grid(), ['W44']);
ok('and a switcher appears above them',
   await p.$$eval('#part-set-bar .part-set-chip', e => e.map(x => [x.textContent, x.classList.contains('active')])),
   [['Main', false], ['Ford plant', true]]);

// ── Switching, and the job remembering ──────────────────────────────────────
await p.click('#part-set-bar .part-set-chip:has-text("Main")'); await p.waitForTimeout(100);
ok('one tap goes back to Main', await grid(), mainButtons);
await p.click('#part-set-bar .part-set-chip:has-text("Ford plant")'); await p.waitForTimeout(900);
const jobId = await p.evaluate(() => _job.id);
await p.evaluate(() => { saveNow(); setActivePartSet(MAIN_PART_SET); openJob(_job.id); });
await p.waitForTimeout(150);
ok('reopening the job brings its set back', await p.evaluate(id => [_job.id === id, activePartSet() !== MAIN_PART_SET], jobId), [true, true]);

// ── Main is still what the lead publishes into ──────────────────────────────
await p.evaluate(() => mergeCrewParts([{ part_number: 'LEAD-1', favorited: true, default_qty: 1, ord: 1 }]));
ok('a published list lands in Main, not in the tech\'s own set',
   await p.evaluate(() => { const own = getFavoritedParts().map(x => x.name);
     setActivePartSet(MAIN_PART_SET); const main = getFavoritedParts().map(x => x.name);
     return [own, main.includes('LEAD-1')]; }), [['W44'], true]);

// ── Deleting ────────────────────────────────────────────────────────────────
await p.evaluate(() => usePartSet(listPartSets()[1].id));
await p.click('#btn-open-library'); await p.waitForTimeout(100);
await p.click('#lib-set-delete');
ok('delete asks for a second tap', await p.$eval('#lib-set-delete', e => e.textContent), 'Tap again to delete');
await p.click('#lib-set-delete'); await p.waitForTimeout(100);
ok('and the set is gone, back on Main', await p.evaluate(() => [listPartSets().length, activePartSet()]), [1, 'main']);
ok('Main cannot be deleted', await p.$eval('#lib-set-delete', e => e.style.display), 'none');

// ── Sets the office publishes ───────────────────────────────────────────────
await p.evaluate(() => closeLibrary());
await p.evaluate(() => { const id = createPartSet('My own'); toggleFavorite('G13'); setActivePartSet(MAIN_PART_SET); return id; });
await p.evaluate(() => mergePublishedSets([
  { id: 'aaa', name: 'Hospital', parts: ['W44', 'G13', 'ZZ-OFFICE-ONLY'], mine: true },
  { id: 'bbb', name: 'Batavia standard', parts: ['G13'], mine: false },
]));
ok('published sets arrive beside the tech\'s own, office ones first',
   await p.evaluate(() => listPartSets().map(s => s.name + (s.published ? '*' : ''))),
   ['Main', 'Hospital*', 'Batavia standard*', 'My own']);
ok('a part only the office knows is added to the library so its button shows',
   await p.evaluate(() => getLibrary().some(x => x.name === 'ZZ-OFFICE-ONLY')), true);

await p.evaluate(() => { renderPartButtons(); });
await p.click('#part-set-bar .part-set-chip:has-text("Hospital")'); await p.waitForTimeout(100);
ok('switching to one gives its buttons, in the office\'s order', await grid(), ['W44', 'G13', 'ZZ-OFFICE-ONLY']);

await p.click('#btn-open-library'); await p.waitForTimeout(150);
ok('in the library it is marked as the office\'s and read-only',
   await p.evaluate(() => [$('lib-set').selectedOptions[0].textContent, $('lib-set-note').style.display,
     $('lib-set-rename').style.display, $('lib-set-delete').style.display, $('lib-set-copy').style.display]),
   ['★ Hospital (office)', '', 'none', 'none', '']);
ok('its stars cannot be changed', await p.$$eval('#lib-list .star-btn', e => e.length > 0 && e.every(x => x.disabled)), true);
await p.evaluate(() => toggleFavorite('W44'));
ok('not even from code', await p.evaluate(() => getFavoritedParts().map(x => x.name)), ['W44', 'G13', 'ZZ-OFFICE-ONLY']);

await p.click('#lib-set-copy'); await p.waitForTimeout(100);
ok('Copy to edit makes a set of the tech\'s own, chosen, with the same buttons',
   await p.evaluate(() => [listPartSets().find(s => s.id === activePartSet()).name, isPublishedPartSet(activePartSet()),
     getFavoritedParts().map(x => x.name)]),
   ['Hospital (mine)', false, ['W44', 'G13', 'ZZ-OFFICE-ONLY']]);
ok('which can be changed', await p.$$eval('#lib-list .star-btn', e => e.every(x => !x.disabled)), true);
await p.click('#btn-close-library'); await p.waitForTimeout(100);

// The office edits one and takes the other down.
await p.evaluate(() => setActivePartSet('pub-bbb'));
await p.evaluate(() => mergePublishedSets([{ id: 'aaa', name: 'Hospital — east', parts: ['W44'], mine: true }]));
ok('a republished set is updated in place, a withdrawn one is gone, the tech\'s own untouched',
   await p.evaluate(() => listPartSets().map(s => s.name)), ['Main', 'Hospital — east', 'My own', 'Hospital (mine)']);
ok('a phone that was on the withdrawn set falls back to Main', await p.evaluate(() => activePartSet()), 'main');
await p.evaluate(() => setActivePartSet('pub-aaa'));
ok('the updated set has the office\'s new buttons', await p.evaluate(() => getFavoritedParts().map(x => x.name)), ['W44']);

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close();
process.exit(fails || errs.length ? 1 : 0);
