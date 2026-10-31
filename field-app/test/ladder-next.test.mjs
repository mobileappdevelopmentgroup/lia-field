// Ladders, one after another: Add & Scan Next adds the ladder and reopens the
// camera, and a scanned serial fills in what the catalogue knows about it — or
// says it knows nothing, and the ladder is added all the same.
//
// The camera is stubbed: startScan() is replaced so the test can see it was
// asked for, and a "scan" is _onScanSuccess() with the value, which is exactly
// what the viewfinder calls when it decodes a barcode.
//
// Run via `npm run test:field`.
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('config.json')) { res.writeHead(404); return res.end(); }
  const file = path.join(ROOT, 'field-app', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(ROOT, 'field-app')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

const b = await chromium.launch();
const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) errs.push('console: ' + m.text()); });
let fails = 0;
const ok = (l,g,w) => { const good = JSON.stringify(g) === JSON.stringify(w); if (!good) fails++;
  console.log((good ? 'ok  ' : `FAIL ${l}: want ${JSON.stringify(w)} got ${JSON.stringify(g)} — `) + l); };

await p.goto(BASE);
await p.waitForTimeout(400);

// One ladder on file.
await p.evaluate(async () => {
  await LiaCache.status();
  const db = await new Promise(r => { const q = indexedDB.open('lia-field'); q.onsuccess = () => r(q.result); });
  await new Promise((res, rej) => {
    const t = db.transaction(['assets'], 'readwrite');
    t.objectStore('assets').put({ asset_id:'l1', serial_key:'100200', serial_raw:'100200', kind:'ladder',
      brand:'Werner', ladder_type:'Step', length:'8', last_inspected:'2025-09-30' });
    t.oncomplete = () => { db.close(); res(); };
    t.onerror = () => rej(t.error);
  });
});

await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="ladder"]').catch(() => {});
await p.waitForTimeout(300);
await p.evaluate(() => { window.__scans = 0; window.startScan = () => { window.__scans++; }; });

ok('both add buttons are offered', await p.evaluate(() => [
     $('btn-add-ladder').offsetParent !== null, $('btn-add-next').offsetParent !== null]), [true, true]);

// ── A ladder on file ────────────────────────────────────────────────────────
await p.evaluate(() => _onScanSuccess('100200'));
await p.waitForTimeout(250);
ok('a scanned serial on file fills in brand, type and length',
   await p.evaluate(() => [$('fi-brand').value, $('fi-type').value, $('fi-length').value]), ['Werner', 'Step', '8']);
ok('and says it was inspected before, so the serial is enough',
   await p.$eval('#fi-lookup', e => [e.className, /Inspected before \(2025-09-30\): Werner · Step · 8 ft/.test(e.textContent)]),
   ['ladder-lookup hit', true]);

await p.click('#btn-add-next'); await p.waitForTimeout(200);
ok('Add & Scan Next adds it', await p.evaluate(() => _job.ladders.map(l => [l.serialNum, l.brand])), [['100200', 'Werner']]);
ok('and reopens the camera', await p.evaluate(() => window.__scans), 1);
ok('with the form ready for the next one', await p.evaluate(() => [$('fi-serial').value, $('fi-lookup').style.display]),
   ['', 'none']);

// ── A ladder we have never seen ─────────────────────────────────────────────
await p.evaluate(() => _onScanSuccess('999111'));
await p.waitForTimeout(250);
ok('a serial never inspected says BSI will need its details',
   await p.$eval('#fi-lookup', e => [e.className, /Never inspected[\s\S]*brand, type and length/.test(e.textContent)]),
   ['ladder-lookup miss', true]);
await p.evaluate(() => { _currentParts.set('G13', 2); renderSelectedParts(); });
await p.click('#btn-add-ladder'); await p.waitForTimeout(200);
ok('and is still added, with its parts', await p.evaluate(() => [_job.ladders[0].serialNum, _job.ladders[0].parts]),
   ['999111', [{ name: 'G13', qty: 2 }]]);
ok('plain Add Ladder does not reopen the camera', await p.evaluate(() => window.__scans), 1);

// ── Inspected on this phone, not yet synced ─────────────────────────────────
await p.evaluate(() => { $('fi-brand').value = ''; $('fi-type').value = ''; $('fi-length').value = '';
  $('fi-brand').value = 'Louisville'; $('fi-type').value = 'Extension'; $('fi-length').value = '24';
  $('fi-serial').value = '555666'; addLadder(); saveNow();
  $('fi-brand').value = ''; $('fi-type').value = ''; $('fi-length').value = ''; });
await p.evaluate(() => _onScanSuccess('555-666'));
await p.waitForTimeout(250);
ok('a ladder recorded on this phone fills in too, before any sync',
   await p.evaluate(() => [$('fi-brand').value, $('fi-type').value, $('fi-length').value, $('fi-lookup').className]),
   ['Louisville', 'Extension', '24', 'ladder-lookup hit']);
await p.evaluate(() => { clearFormAll(); });

// ── What the tech entered is his; what the server has wins ──────────────────
await p.evaluate(() => _onScanSuccess('100200'));            // Werner, filled
await p.waitForTimeout(250);
await p.evaluate(() => _onScanSuccess('777888'));            // wrong one — rescanned, unknown
await p.waitForTimeout(250);
ok('rescanning to an unknown serial clears what the first scan filled in',
   await p.evaluate(() => [$('fi-brand').value, $('fi-type').value, $('fi-length').value]), ['', '', '']);
await p.fill('#fi-brand', 'Little Giant');
await p.evaluate(() => _onScanSuccess('888999'));            // unknown again
await p.waitForTimeout(250);
ok('but never what the tech typed himself', await p.evaluate(() => $('fi-brand').value), 'Little Giant');
await p.evaluate(() => _onScanSuccess('100200'));
await p.waitForTimeout(250);
ok('the tech\'s own edit beats the server; the rest comes from the server',
   await p.evaluate(() => [$('fi-brand').value, $('fi-type').value, $('fi-length').value]), ['Little Giant', 'Step', '8']);
await p.evaluate(() => clearFormAll());

// Carried over from the last ladder: the next known ladder's record replaces it.
await p.evaluate(() => { $('fi-serial').value = '424242'; $('fi-brand').value = 'Louisville';
  $('fi-type').value = 'Extension'; $('fi-length').value = '28'; addLadder(); });
ok('after adding, the details carry over to the next ladder',
   await p.evaluate(() => [$('fi-brand').value, $('fi-brand').dataset.src]), ['Louisville', 'carry']);
await p.evaluate(() => _onScanSuccess('100200'));
await p.waitForTimeout(250);
ok('and a known ladder\'s record replaces what carried over',
   await p.evaluate(() => [$('fi-brand').value, $('fi-type').value, $('fi-length').value]), ['Werner', 'Step', '8']);
await p.evaluate(() => { const i = _job.ladders.findIndex(l => l.serialNum === '424242'); _job.ladders.splice(i, 1); });
await p.evaluate(() => clearFormAll());

// ── Typed, not scanned: the same lookup ─────────────────────────────────────
await p.fill('#fi-serial', '100200');
await p.press('#fi-serial', 'Enter');
await p.evaluate(() => $('fi-serial').blur());
await p.waitForTimeout(250);
ok('a typed serial is looked up exactly like a scanned one',
   await p.evaluate(() => [$('fi-brand').value, $('fi-lookup').className]), ['Werner', 'ladder-lookup hit']);
await p.evaluate(() => clearFormAll());

// ── A refused add does not open the camera ──────────────────────────────────
await p.click('#btn-add-next'); await p.waitForTimeout(200);
ok('with no serial, nothing is added and the camera stays shut',
   await p.evaluate(() => [_job.ladders.length, window.__scans]), [3, 1]);

// ── Editing hides it ────────────────────────────────────────────────────────
await p.evaluate(() => setEditMode(true));
ok('editing a ladder hides Add & Scan Next', await p.$eval('#btn-add-next', e => e.style.display), 'none');
await p.evaluate(() => setEditMode(false));
ok('and it comes back after', await p.$eval('#btn-add-next', e => e.style.display), '');

// ── Add & Scan Next leaves the keyboard down ────────────────────────────────
await p.evaluate(() => { clearFormAll(); $('fi-serial').value = '313131'; });
await p.click('#btn-add-next'); await p.waitForTimeout(200);
ok('Add & Scan Next does not put the cursor in the serial field (the keyboard would cover the camera)',
   await p.evaluate(() => document.activeElement && document.activeElement.id === 'fi-serial'), false);

// ── Add & Duplicate ─────────────────────────────────────────────────────────
// The real scanner, stubbed at the camera: startScan resolves "live" and
// stopScan is counted, so the run can be watched end to end.
await p.evaluate(() => {
  clearFormAll();
  window.__scans = 0; window.__stops = 0;
  // A live viewfinder: without a stream the run takes the one-photo fallback.
  window.startScan = () => { window.__scans++; _scanStream = { getTracks: () => [] }; return Promise.resolve(true); };
  _job.ladders = _job.ladders.filter(l => l.serialNum !== '100200');
  const real = window.stopScan; window.stopScan = () => { window.__stops++; real(); };
  $('fi-serial').value = '700001';
  _currentParts.set('G13', 2); _currentParts.set('W44', 1); renderSelectedParts();
  _currentFlags.lubricated = true;
});
const before = await p.evaluate(() => _job.ladders.length);
await p.click('#btn-add-dup'); await p.waitForTimeout(200);
ok('Add & Duplicate adds the ladder on the form and opens the camera',
   await p.evaluate(() => [_job.ladders[0].serialNum, window.__scans, ladderBatchActive(), $('btn-scan-cancel').textContent]),
   ['700001', 1, true, 'Done']);

await p.evaluate(() => _onScanSuccess('700002')); await p.waitForTimeout(400);
await p.evaluate(() => _onScanSuccess('700002')); await p.waitForTimeout(100);   // same barcode, next tick
await p.evaluate(() => _onScanSuccess('100200')); await p.waitForTimeout(400);   // a ladder on file
ok('every new barcode becomes a ladder with the same parts, and the camera stays open',
   await p.evaluate(() => _job.ladders.slice(0, 3).map(l => [l.serialNum, l.parts.map(x => x.name + 'x' + x.qty).join(',')])),
   [['100200', 'G13x2,W44x1'], ['700002', 'G13x2,W44x1'], ['700001', 'G13x2,W44x1']]);
ok('reading the same barcode twice adds it once', await p.evaluate(() => _job.ladders.length), before + 3);
ok('a known ladder keeps its own brand', await p.evaluate(() => _job.ladders[0].brand), 'Werner');
ok('the flags are not duplicated', await p.evaluate(() => [_job.ladders[0].flags.lubricated, _job.ladders[2].flags.lubricated]),
   [null, true]);
ok('the camera was never closed mid-run', await p.evaluate(() => window.__stops), 0);

await p.evaluate(() => _onScanSuccess('70A003')); await p.waitForTimeout(200);
ok('a read that is not a serial is not added', await p.evaluate(() => [_job.ladders.length, $('scan-hint').classList.contains('warn')]),
   [before + 3, true]);

await p.$eval('#btn-scan-cancel', e => e.click()); await p.waitForTimeout(200);
ok('Done ends it and opens the last ladder scanned for editing',
   await p.evaluate(() => [ladderBatchActive(), _editingIdx, $('fi-serial').value, $('btn-scan-cancel').textContent]),
   [false, 0, '100200', 'Cancel']);
ok('while editing, Add & Duplicate is hidden', await p.$eval('#btn-add-dup', e => e.style.display), 'none');
await p.evaluate(() => cancelEdit());

// ── A serial nobody knows: brand, type and length from buttons ──────────────
await p.evaluate(() => { clearFormAll(); });
await p.evaluate(() => _onScanSuccess('424299')); await p.waitForTimeout(250);
ok('a serial not on file offers the button picker', await p.$eval('#btn-pick-details', e => e.textContent), 'Pick brand, type & length');
await p.click('#btn-pick-details'); await p.waitForTimeout(100);
const btns = () => p.$$eval('#parts-grid .part-btn', e => e.map(x => x.textContent));
ok('the part buttons become brands', (await btns()).slice(0, 3), ['Little Giant', 'Werner', 'Louisville']);
ok('with the step named above them', await p.$eval('#part-set-bar .detail-step', e => e.textContent), 'Brand · 1 of 3');
await p.click('#parts-grid .part-btn:has-text("Louisville")'); await p.waitForTimeout(100);
ok('a brand tap fills Brand and moves on to Type',
   await p.evaluate(() => [$('fi-brand').value, $('fi-brand').dataset.src || null]), ['Louisville', null]);
ok('the buttons are now types', (await btns()).slice(0, 2), ['Extension', 'Step']);
await p.click('#parts-grid .part-btn:has-text("Extension")'); await p.waitForTimeout(100);
ok('then lengths, long ones for an extension ladder', (await btns()).slice(0, 2), ['8 ft', '10 ft']);
await p.click('#parts-grid .part-btn:has-text("28 ft")'); await p.waitForTimeout(100);
ok('the last tap fills Length and the parts come back',
   await p.evaluate(() => [$('fi-type').value, $('fi-length').value, _detailStep, !!document.querySelector('#parts-grid .detail-btn')]),
   ['Extension', '28', null, false]);

await p.click('#btn-pick-details'); await p.waitForTimeout(100);
await p.click('#part-set-bar .part-set-chip:has-text("Skip")'); await p.waitForTimeout(100);
ok('Skip leaves a field as it was and moves on', await p.$eval('#part-set-bar .detail-step', e => e.textContent), 'Type · 2 of 3');
ok('the current answer is lit', await p.$eval('#parts-grid .part-btn.active', e => e.textContent), 'Extension');
await p.click('#parts-grid .part-btn:has-text("Type it")'); await p.waitForTimeout(100);
ok('Type it puts the cursor in the field and the parts back',
   await p.evaluate(() => [document.activeElement.id, _detailStep]), ['fi-type', null]);

await p.click('#btn-pick-details'); await p.waitForTimeout(100);
await p.evaluate(() => _onScanSuccess('100200')); await p.waitForTimeout(250);
ok('scanning a known ladder puts the parts back', await p.evaluate(() => _detailStep), null);
await p.evaluate(() => clearFormAll());

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
