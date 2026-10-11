// Tap-through: how techs work a rack. Tap starts the run, and each tap IS the
// pass — recorded the moment it is made, the reader staying on for the next.
// Fail (which takes that pass back out) is the only thing pressed for a defect.
//
// Served over HTTP because the run leans on IndexedDB (the catalogue) and
// fetch (config.json), neither of which works under file://.
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

// A stand-in for @exxili/capacitor-nfc, installed before any page script runs
// so the Tap-through button is wired the way it is on a real handset. Reports
// android, where the stream needs no re-arming.
const nfcStub = (platform) => {
  const listeners = {};
  window.__nfc = { started: 0, cancelled: 0 };
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: { NFC: {
      startScan: async () => { window.__nfc.started++; throw new Error("Android NFC scanning does not require 'startScan' method."); },
      cancelScan: () => { window.__nfc.cancelled++; return Promise.reject(new Error('not implemented')); },
      writeNDEF: async () => {},
      addListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn);
        return Promise.resolve({ remove: () => { listeners[name] = (listeners[name]||[]).filter(f => f !== fn); } }); },
    } },
  };
  // Raw NDEF payloads, base64'd, exactly as the plugin delivers them.
  const b64 = a => btoa(String.fromCharCode.apply(null, a));
  const u8 = s => Array.from(new TextEncoder().encode(s));
  window.__tap = (opts) => {
    const records = [];
    if (opts.url) records.push({ type: 'U', payload: b64([0x04].concat(u8(opts.url.replace(/^https:\/\//,'')))) });
    if (opts.serial) records.push({ type: 'T', payload: b64([0x02].concat(u8('en'), u8(opts.serial))) });
    (listeners.nfcTag || []).forEach(fn => fn({
      messages: records.length ? [{ records }] : [],
      tagInfo: opts.uid ? { uid: opts.uid } : undefined,
    }));
  };
  window.__liveListeners = () => (listeners.nfcTag || []).length;
};
await p.addInitScript(nfcStub, 'android');

await p.goto(BASE);
await p.waitForTimeout(400);

// Seed the on-device catalogue: three items with types, one with no type.
const seed = pg => pg.evaluate(async () => {
  await LiaCache.status();                       // creates the v2 schema
  const db = await new Promise(r => { const q = indexedDB.open('lia-field'); q.onsuccess = () => r(q.result); });
  await new Promise((res, rej) => {
    const t = db.transaction(['assets','meta'], 'readwrite');
    const s = t.objectStore('assets');
    s.put({ asset_id:'a1', serial_key:'H1', serial_raw:'H-1', kind:'fall_protection',
            tag_key:'04A1B2C3', public_ref:'REF0000001', item_type:'Body harness', manufacturer:'MSA', model:'V-FIT' });
    s.put({ asset_id:'a2', serial_key:'H2', serial_raw:'H-2', kind:'fall_protection',
            tag_key:'', public_ref:'REF0000002', item_type:'Lanyard', manufacturer:'MSA' });
    s.put({ asset_id:'a3', serial_key:'H3', serial_raw:'H-3', kind:'fall_protection',
            tag_key:'', public_ref:'REF0000003', item_type:'', manufacturer:'MSA' });
    s.put({ asset_id:'a4', serial_key:'H4', serial_raw:'H-4', kind:'fall_protection',
            tag_key:'', public_ref:'REF0000004', item_type:'Lanyard', manufacturer:'3M' });
    t.objectStore('meta').put({ key:'sync', since:'2026-01-01T00:00:00Z', at:new Date().toISOString(), count:4 });
    t.oncomplete = () => { db.close(); res(); };
    t.onerror = () => rej(t.error);
  });
});

await seed(p);

await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);

const items = () => p.evaluate(() => _job.items.map(i => [i.serial_num, i.overall_pass]).reverse());
const queued = () => p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue') || '[]')
  .filter(e => e.kind === 'fall_protection').map(e => e.payload.serial_num));
const failCheck = async (pg) => pg.evaluate(() => { const b = document.querySelectorAll('#fp-checks-list .fp-seg')[0].querySelectorAll('button');
  (_fpChecks[0].pass_answer ? b[1] : b[0]).click(); });

// ── Tap starts the run ──────────────────────────────────────────────────────
ok('the four ways are unchanged',
   await p.$$eval('.fp-way', e => e.map(x => x.textContent.trim())), ['Tap & pass','Scan','Type','New']);
ok('there is no separate tap-through button — Tap is it', await p.$('#fp-btn-batch'), null);
await p.click('#fp-btn-tap'); await p.waitForTimeout(150);
ok('Tap starts a run, taking over the input bar', await p.evaluate(() => ({
     input: $('fp-input-panel').style.display !== 'none',
     batch: $('fp-batch-panel').style.display !== 'none',
   })), { input:false, batch:true });
ok('a listener is live', await p.evaluate(() => window.__liveListeners()), 1);
ok('and Android is not asked to re-arm',
   await p.$eval('#fp-btn-batch-arm', e => e.style.display), 'none');

// ── One tap is the pass ─────────────────────────────────────────────────────
await p.evaluate(() => window.__tap({ serial:'H-1', url:'https://lia.test/fp/?t=REF0000001', uid:'04:A1:B2:C3' }));
await p.waitForTimeout(250);
ok('a tap records the item as passed straight away', await items(), [['H-1', true]]);
const first = await p.evaluate(() => _job.items[0]);
ok('against the checklist for its type', first.item_type, 'Body harness');
ok('with every check answered at its passing answer',
   first.checks.length > 0 && first.checks.every(c => c.answer === c.pass_answer), true);
ok('recorded as a tap-through pass, not as answered on screen', first.source, 'field_batch');
ok('keeping the link off the tag', first.tag_url, 'https://lia.test/fp/?t=REF0000001');
ok('queued for upload', await queued(), ['H-1']);
ok('the reader is still listening for the next one', await p.evaluate(() => window.__liveListeners()), 1);
ok('nothing is left in hand', await p.evaluate(() => !!_fpItem), false);
ok('the run shows the pass', await p.$eval('#fp-batch-last', e => /H-1[\s\S]*Passed/.test(e.textContent)), true);
ok('and counts it', await p.$eval('#fp-batch-count', e => e.textContent), '1 passed');
ok('Fail and Edit info stay offered for the item just tapped', await p.evaluate(() => ({
     cur: $('fp-batch-cur').style.display !== 'none', edit: $('fp-btn-batch-edit').textContent })),
   { cur:true, edit:'Edit info' });

// A tag left against the phone fires repeatedly; that is one presentation.
await p.evaluate(() => { window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); });
await p.waitForTimeout(250);
ok('a tag held against the phone is one pass, not three', await items(), [['H-1', true]]);
await p.evaluate(() => { _fpBatch.lastAt = {}; window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); });
await p.waitForTimeout(250);
ok('tapping it again later changes nothing', await items(), [['H-1', true]]);
ok('and says it is already done', await p.$eval('#fp-batch-hint', e => /already in this run/.test(e.textContent)), true);

await p.evaluate(() => window.__tap({ url:'https://lia.test/fp/?t=REF0000002' }));
await p.waitForTimeout(250);
ok('the next tap passes the next item, found by its certificate code', await items(), [['H-1', true], ['H-2', true]]);

// ── Fail straight after the tap ─────────────────────────────────────────────
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(200);
ok('Fail takes that pass back out of the job', await items(), [['H-1', true]]);
ok('and out of the upload queue, so it cannot reach the server', await queued(), ['H-1']);
ok('putting the item on screen to fail', await p.evaluate(() => _fpItem && _fpItem.serial_raw), 'H-2');
ok('and stops the reader, so no tap can land meanwhile',
   await p.evaluate(() => window.__liveListeners()), 0);
ok('opens the checks', await p.$$eval('#fp-checks-list button', b => b.every(x => !x.disabled)), true);
ok('and will not save until a check is marked failed', await p.evaluate(() => ({
     shown: $('fp-save-panel').style.display !== 'none', disabled: $('fp-btn-save').disabled })),
   { shown:true, disabled:true });

// Changed their mind: it passes after all, as the tap said.
await p.click('#fp-btn-fail-cancel'); await p.waitForTimeout(200);
ok('cancelling the fail records the pass again', await items(), [['H-1', true], ['H-2', true]]);
ok('with the reader back on', await p.evaluate(() => window.__liveListeners()), 1);

// Fail it for real: a check, then a photo.
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(200);
await failCheck(p); await p.waitForTimeout(150);
ok('marking a check turns the save into a removal', await p.$eval('#fp-btn-save', e => [e.textContent.trim(), e.disabled]),
   ['Add Photo & Remove →', false]);
await p.click('#fp-btn-save'); await p.waitForTimeout(200);
ok('which asks for a photo', await p.evaluate(() => !$('fp-condemn-sheet').classList.contains('hidden')), true);
ok('and will not confirm without one', await p.$eval('#fp-btn-confirm-condemn', e => e.disabled), true);
await p.evaluate(() => window.__tap({ serial:'H-4' })); await p.waitForTimeout(250);
ok('no tap can land while an item is being failed', await items(), [['H-1', true]]);
await p.evaluate(() => { const blob = new Blob([new Uint8Array([0xff,0xd8,0xff,0xd9])], { type:'image/jpeg' });
  _fpPhoto = { blob, bytes:4, width:1, height:1, capturedAt:new Date().toISOString(), previewUrl:URL.createObjectURL(blob) }; fpRenderPhoto(); });
await p.click('#fp-btn-confirm-condemn'); await p.waitForTimeout(300);
ok('the item is recorded as failed — the only record of it', await items(), [['H-1', true], ['H-2', false]]);
const failed = await p.evaluate(() => _job.items[0]);
ok('as answered on screen', failed.source, 'field');
ok('with its photo kept in the photo store, not in the job',
   [!!failed.photo.id, failed.photo.dataUrl, await p.evaluate(id => LiaPhotos.get(id).then(r => !!(r && r.blob)), failed.photo.id)],
   [true, undefined, true]);
ok('and queued for upload behind its inspection', await p.evaluate(id => {
     const q = JSON.parse(localStorage.getItem('lia-upload-queue'));
     const a = q.findIndex(e => e.clientId === id), b = q.findIndex(e => e.clientId === id + ':photo');
     return [a >= 0, b > a, q[b] && q[b].kind];
   }, failed.id), [true, true, 'fp_photo']);
ok('the queue holds the failure and not the pass it replaced', await queued(), ['H-1', 'H-2']);
ok('and the run is listening again', await p.evaluate(() => window.__liveListeners()), 1);
ok('counting it', await p.$eval('#fp-batch-count', e => e.textContent), '1 passed · 1 failed');
ok('Fail is not offered on an item already failed',
   await p.evaluate(() => $('fp-batch-cur').style.display), 'none');

// ── Too little to pass: Add info, or it is skipped ──────────────────────────
await p.evaluate(() => { _fpBatch.lastAt = {}; window.__tap({ serial:'H-3' }); });   // on file, no type
await p.waitForTimeout(300);
ok('an item with no type is not recorded — it stays on screen with Add info', await p.evaluate(() => ({
     serial: _fpItem && _fpItem.serial_raw, live: window.__liveListeners(), edit: $('fp-btn-batch-edit').textContent })),
   { serial:'H-3', live:1, edit:'Add info' });
ok('nothing recorded for it yet', (await items()).length, 2);
await p.evaluate(() => window.__tap({ serial:'H-4' }));
await p.waitForTimeout(300);
ok('tapping on without it skips it, and passes the next', await items(), [['H-1', true], ['H-2', false], ['H-4', true]]);
ok('and says so', await p.$eval('#fp-batch-hint', e => /H-4 passed/.test(e.textContent)), true);
ok('counting the skip', await p.$eval('#fp-batch-count', e => e.textContent), '2 passed · 1 failed · 1 skipped');

// Fail on an item that cannot be recorded must not reach back to the pass before it.
await p.evaluate(() => { _fpBatch.lastAt = {}; window.__tap({ serial:'H-3' }); });
await p.waitForTimeout(300);
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(150);
ok('Fail on an untyped item asks for its type, and leaves H-4 passed', await p.evaluate(() => [
     _fpItem.serial_raw, $('fp-edit-form').style.display !== 'none', _job.items.some(i => i.serial_num === 'H-4')]),
   ['H-3', true, true]);
await p.selectOption('#fpf-equipment_type', await p.evaluate(() => LiaFpTypes.all()[0].slug));
await p.fill('#fpf-manufacturer', 'Guardian');
await p.click('#fp-btn-done-edit'); await p.waitForTimeout(250);
const h3 = await p.evaluate(() => _job.items.find(i => i.serial_num === 'H-3'));
ok('Done on the filled-in item records it as passed there and then',
   h3 && [h3.overall_pass, h3.manufacturer, h3.source], [true, 'Guardian', 'field_batch']);

// Edit info on the item just passed: the pass comes out, Done puts it back corrected.
await p.click('#fp-btn-batch-edit'); await p.waitForTimeout(150);
ok('Edit info on a passed item takes the pass back out while editing',
   await p.evaluate(() => [_job.items.some(i => i.serial_num === 'H-3'), $('fp-edit-form').style.display !== 'none']), [false, true]);
ok('without stopping the reader on Android', await p.evaluate(() => window.__liveListeners()), 1);
await p.fill('#fpf-manufacturer', 'Guardian Fall');
// A tap mid-edit is the tech moving on: the item passes with what was typed.
await p.evaluate(() => window.__tap({ url:'https://acme.example/tag/FP158354', uid:'AB:CD:EF:01' }));
await p.waitForTimeout(400);
const h3b = await p.evaluate(() => _job.items.filter(i => i.serial_num === 'H-3'));
ok('a tap mid-edit records it once, with the correction',
   h3b.map(i => [i.overall_pass, i.manufacturer]), [[true, 'Guardian Fall']]);

// ── An unknown tag: on screen, blank, with its link kept ─────────────────────
ok('a foreign tag does not stop the run or open the link sheet', await p.evaluate(() => ({
     sheet: !$('fp-link-sheet').classList.contains('hidden'), live: window.__liveListeners() })),
   { sheet:false, live:1 });
ok('it is on screen with the serial box EMPTY, never the hardware id',
   await p.evaluate(() => _fpItem.serial_raw), '');
ok('carrying the link and the tag id', await p.evaluate(() => [_fpItem.tag_url, _fpItem.nfc_tag_uid]),
   ['https://acme.example/tag/FP158354', 'ABCDEF01']);
ok('and offering Add info', await p.$eval('#fp-btn-batch-edit', e => e.textContent), 'Add info');
const beforeLink = (await items()).length;
await p.click('#fp-btn-batch-stop'); await p.waitForTimeout(300);
ok('finishing on it records no inspection', (await items()).length, beforeLink);
ok('but keeps the link, so the next tap on it resolves',
   await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue')).pop().kind), 'fp_tag_link');
ok('and the run is over', await p.evaluate(() => ({ batch: !!_fpBatch, live: window.__liveListeners() })),
   { batch:false, live:0 });

// ── Typed or scanned, the same as a tap ─────────────────────────────────────
await p.evaluate(() => { _job.items = []; fpRenderAll(); });
await p.click('#fp-btn-tap'); await p.waitForTimeout(200);
await p.click('#fp-btn-batch-type'); await p.waitForTimeout(100);
await p.fill('#fp-batch-serial', 'H-1'); await p.press('#fp-batch-serial', 'Enter');
await p.waitForTimeout(300);
ok('a typed serial is passed like a tap', await items(), [['H-1', true]]);
await p.evaluate(() => { window.startScan = () => {}; });
await p.click('#fp-btn-batch-scan'); await p.waitForTimeout(100);
await p.evaluate(() => _onScanSuccess('H-2')); await p.waitForTimeout(300);
ok('and so is a scanned one', await p.evaluate(() => _job.items.map(i => [i.serial_num, i.source]).reverse()),
   [['H-1', 'field_batch'], ['H-2', 'field_batch']]);
ok('the reader is still listening after the scan', await p.evaluate(() => window.__liveListeners()), 1);
ok('Finish has nothing left to pass', await p.$eval('#fp-btn-batch-stop', e => e.textContent), 'Finish');
await p.click('#fp-btn-batch-stop'); await p.waitForTimeout(200);
ok('and finishing records nothing more', (await items()).length, 2);

// ── Saved on every tap; the app dying loses nothing ────────────────────────
await p.evaluate(() => { _job.items = []; saveNow(); });
await p.click('#fp-btn-tap'); await p.waitForTimeout(200);
await p.evaluate(() => window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' })); await p.waitForTimeout(300);
const jobId = await p.evaluate(() => _job.id);
await p.reload(); await p.waitForTimeout(500);       // the app dies
ok('a tap is in the saved job the moment it is made',
   await p.evaluate(id => loadJobs()[id].items.map(i => [i.serial_num, i.overall_pass, i.source]), jobId),
   [['H-1', true, 'field_batch']]);
await p.evaluate(id => openJob(id), jobId); await p.waitForTimeout(400);

// Edit info, then the app dies: the item had passed, and still has.
await p.click('#fp-btn-tap'); await p.waitForTimeout(200);
await p.evaluate(() => window.__tap({ serial:'H-4' })); await p.waitForTimeout(300);
await p.click('#fp-btn-batch-edit'); await p.waitForTimeout(150);
await p.reload(); await p.waitForTimeout(500);
await p.evaluate(id => openJob(id), jobId); await p.waitForTimeout(400);
ok('an item being edited when the app died is recorded as passed, once',
   await p.evaluate(() => _job.items.filter(i => i.serial_num === 'H-4').map(i => i.overall_pass)), [true]);

// ── Failed with no photo: the one alert ─────────────────────────────────────
await p.click('#fp-btn-tap'); await p.waitForTimeout(200);
await p.evaluate(() => window.__tap({ serial:'H-2' })); await p.waitForTimeout(300);
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(150);
await failCheck(p); await p.waitForTimeout(100);
await p.evaluate(() => goScreen('jobs')); await p.waitForTimeout(200);
ok('leaving with a failed item that has no photo is stopped', await p.evaluate(() => ({
     stayed: $('screen-detail').classList.contains('active'),
     alert: !$('fp-alert').classList.contains('hidden') })), { stayed:true, alert:true });
ok('saying what is at stake', await p.$eval('#fp-alert-msg', e => /H-2[\s\S]*no photo[\s\S]*not recorded/.test(e.textContent)), true);
await p.click('#fp-alert-go'); await p.waitForTimeout(200);
ok('Take the photo goes straight to the photo', await p.evaluate(() => !$('fp-condemn-sheet').classList.contains('hidden')), true);
await p.click('#fp-btn-cancel-condemn'); await p.waitForTimeout(150);

// The app dies mid-fail: reopening brings it back, and says so.
await p.reload(); await p.waitForTimeout(500);
await p.evaluate(id => openJob(id), jobId); await p.waitForTimeout(400);
ok('a failed item the app died on comes back on screen, not recorded as passed', await p.evaluate(() => ({
     serial: _fpItem && _fpItem.serial_raw, recorded: _job.items.some(i => i.serial_num === 'H-2'),
     alert: !$('fp-alert').classList.contains('hidden') })), { serial:'H-2', recorded:false, alert:true });
ok('with the check that was failed still failed',
   await p.evaluate(() => _fpChecks.some(c => c.answer !== c.pass_answer)), true);
ok('and only one way on from there: take the photo',
   await p.$eval('#fp-alert-leave', e => e.style.display), 'none');
await p.click('#fp-alert-go'); await p.waitForTimeout(150);
await p.click('#fp-btn-cancel-condemn'); await p.waitForTimeout(150);
await p.evaluate(() => goScreen('jobs')); await p.waitForTimeout(150);
await p.click('#fp-alert-leave'); await p.waitForTimeout(200);
ok('"Leave — don\'t record it" leaves, recording nothing', await p.evaluate(id => ({
     jobs: $('screen-jobs').classList.contains('active'),
     recorded: loadJobs()[id].items.some(i => i.serial_num === 'H-2'),
     held: !!loadJobs()[id].fpInProgress }), jobId), { jobs:true, recorded:false, held:false });
await p.evaluate(id => openJob(id), jobId); await p.waitForTimeout(300);

// ── A run cannot outlive the screen it belongs to ───────────────────────────
await p.click('#fp-btn-tap'); await p.waitForTimeout(200);
await p.evaluate(() => { _job.items = []; saveNow(); _fpBatch.lastAt = {}; window.__tap({ serial:'H-2' }); });
await p.waitForTimeout(300);
await p.evaluate(() => goScreen('jobs')); await p.waitForTimeout(200);
ok('leaving the screen keeps the pass, recorded once',
   await p.evaluate(() => loadJobs()[_job.id].items.map(i => [i.serial_num, i.overall_pass, i.source])),
   [['H-2', true, 'field_batch']]);
ok('ends the run and releases the reader',
   await p.evaluate(() => ({ live: window.__liveListeners(), batch: !!_fpBatch })),
   { live:0, batch:false });
ok('and puts the batch panel away',
   await p.evaluate(() => $('fp-batch-panel').style.display), 'none');

// ── Viewing a tag without inspecting it ─────────────────────────────────────
await p.evaluate(id => openJob(id), await p.evaluate(() => _job.id)); await p.waitForTimeout(300);
const viewTag = async (res) => {
  await p.evaluate(r => { window.LiaNfc.read = () => Promise.resolve(r); }, res);
  await p.click('#fp-btn-view'); await p.waitForTimeout(300);
};
ok('there is a way to view a tag', await p.$eval('#fp-btn-view', e => e.style.display !== 'none'), true);
const beforeView = await p.evaluate(() => [_job.items.length, LiaSync.queueLength()]);
await viewTag({ serial:'H-1', uid:'04A1B2C3', url:'https://lia.test/fp/?t=REF0000001' });
ok('viewing shows the item on file', await p.$eval('#fp-view-panel', e => [
     e.style.display !== 'none', /On file/.test(e.textContent), /H-1/.test(e.textContent), /Body harness/.test(e.textContent)]),
   [true, true, true, true]);
ok('and what is on the tag itself', await p.$eval('#fp-view-panel', e =>
     /On the tag[\s\S]*H-1[\s\S]*04A1B2C3[\s\S]*REF0000001/.test(e.textContent)), true);
ok('records nothing and queues nothing', await p.evaluate(() => [_job.items.length, LiaSync.queueLength()]), beforeView);
ok('starts no run and opens no checks', await p.evaluate(() => [!!_fpBatch, !!_fpItem,
     $('fp-checks-panel').style.display !== 'none', window.__liveListeners()]), [false, false, false, 0]);
await p.click('#fp-btn-view-close'); await p.waitForTimeout(150);
ok('Close puts the job back as it was', await p.evaluate(() => [$('fp-view-panel').style.display,
     $('fp-items-panel').style.display !== 'none']), ['none', true]);

await viewTag({ serial:'ZZ-404' });
ok('a tag we do not know says so, still recording nothing', await p.$eval('#fp-view-panel', e =>
     /Not on file/.test(e.textContent) && /ZZ-404/.test(e.textContent)), true);
await p.click('#fp-btn-view-close'); await p.waitForTimeout(150);

await viewTag({ serial:'H-4' });
await p.click('#fp-btn-view-inspect'); await p.waitForTimeout(200);
ok('Inspect it brings the item up to inspect, one at a time', await p.evaluate(() => [
     _fpItem && _fpItem.serial_raw, !!_fpBatch, $('fp-btn-save').textContent.trim(), $('fp-view-panel').style.display]),
   ['H-4', false, 'Pass & Next Item', 'none']);
await p.evaluate(() => fpReset());

// ── iOS: same flow, but Apple's sheet sits over the app ─────────────────────
const q = await b.newPage();
q.on('pageerror', e => errs.push('ios: ' + e.message));
await q.addInitScript(nfcStub, 'ios');
await q.goto(BASE); await q.waitForTimeout(400);
await seed(q);
await q.click('#btn-new-job'); await q.waitForTimeout(150);
await q.click('.scope-opt[data-scope="fall_protection"]'); await q.waitForTimeout(300);
await q.click('#fp-btn-tap'); await q.waitForTimeout(200);
await q.evaluate(() => window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' })); await q.waitForTimeout(300);
ok('iOS: a tap is recorded as passed the same way',
   await q.evaluate(() => _job.items.map(i => [i.serial_num, i.source])), [['H-1', 'field_batch']]);
await q.click('#fp-btn-batch-edit'); await q.waitForTimeout(150);
ok('iOS: Edit info stops the reader so its sheet does not cover the form',
   await q.evaluate(() => window.__liveListeners()), 0);
await q.click('#fp-btn-done-edit'); await q.waitForTimeout(200);
ok('iOS: Done records it again and brings the reader back',
   await q.evaluate(() => [_job.items.map(i => i.serial_num), window.__liveListeners()]), [['H-1'], 1]);
await q.close();

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
