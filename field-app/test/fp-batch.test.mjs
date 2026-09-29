// Tap-through: the second way techs work a rack. Single tap is unchanged and
// tested in fp-capture; this covers the run — a tap puts the item on screen,
// the next tap passes it, and Fail is the only thing pressed for a defect.
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
    t.objectStore('meta').put({ key:'sync', since:'2026-01-01T00:00:00Z', at:new Date().toISOString(), count:3 });
    t.oncomplete = () => { db.close(); res(); };
    t.onerror = () => rej(t.error);
  });
});

await seed(p);

await p.click('#btn-new-job'); await p.waitForTimeout(150);
await p.click('.scope-opt[data-scope="fall_protection"]'); await p.waitForTimeout(300);

// ── Both ways stay on offer ─────────────────────────────────────────────────
ok('single tap is still one of the four ways',
   await p.$$eval('.fp-way', e => e.map(x => x.textContent.trim())), ['Tap','Scan','Type','New']);
ok('and tap-through is offered alongside it, not instead',
   await p.$eval('#fp-btn-batch', e => e.style.display !== 'none'), true);

// ── A run ───────────────────────────────────────────────────────────────────
await p.click('#fp-btn-batch'); await p.waitForTimeout(150);
ok('starting a run takes over the input bar', await p.evaluate(() => ({
     input: $('fp-input-panel').style.display !== 'none',
     batch: $('fp-batch-panel').style.display !== 'none',
   })), { input:false, batch:true });
ok('a listener is live', await p.evaluate(() => window.__liveListeners()), 1);
ok('and Android is not asked to re-arm',
   await p.$eval('#fp-btn-batch-arm', e => e.style.display), 'none');

await p.evaluate(() => window.__tap({ serial:'H-1', url:'https://lia.test/fp/?t=REF0000001', uid:'04:A1:B2:C3' }));
await p.waitForTimeout(250);
ok('a tap puts the item on screen as the one being inspected', await p.evaluate(() => ({
     serial: _fpItem && _fpItem.serial_raw, checks: $('fp-checks-panel').style.display !== 'none' })),
   { serial:'H-1', checks:true });
ok('with every check at its passing answer',
   await p.evaluate(() => _fpChecks.length > 0 && _fpChecks.every(c => c.answer === c.pass_answer)), true);
ok('locked until the tech says it failed',
   await p.$$eval('#fp-checks-list button', b => b.every(x => x.disabled)), true);
ok('with no save button — the next tap is the save',
   await p.evaluate(() => $('fp-save-panel').style.display), 'none');
ok('Fail and Edit info are offered beside it', await p.evaluate(() => ({
     cur: $('fp-batch-cur').style.display !== 'none', edit: $('fp-btn-batch-edit').textContent })),
   { cur:true, edit:'Edit info' });
ok('and the reader is still listening', await p.evaluate(() => window.__liveListeners()), 1);
ok('nothing is recorded by the tap itself', await p.evaluate(() => _job.items.length), 0);

// A tag left against the phone fires repeatedly; that is one presentation, and
// it must not confirm the item it is presenting.
await p.evaluate(() => { window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); });
await p.waitForTimeout(250);
ok('a tag held against the phone does not pass itself',
   await p.evaluate(() => _job.items.length), 0);
// Past the repeat window, the same tag again is still not "the next item".
await p.evaluate(() => { _fpBatch.lastAt = {}; window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }); });
await p.waitForTimeout(250);
ok('nor does tapping it again later', await p.evaluate(() => _job.items.length), 0);

// The next tag: the one before it passed.
await p.evaluate(() => window.__tap({ url:'https://lia.test/fp/?t=REF0000002' }));
await p.waitForTimeout(250);
ok('the next tap records the previous item', await p.evaluate(() => _job.items.length), 1);
const first = await p.evaluate(() => _job.items[0]);
ok('as a pass', [first.serial_num, first.overall_pass], ['H-1', true]);
ok('against the checklist for its type', first.item_type, 'Body harness');
ok('with every check answered at its passing answer',
   first.checks.every(c => c.answer === c.pass_answer), true);
ok('recorded as a tap-through pass, not as answered on screen', first.source, 'field_batch');
ok('keeping the link off the tag', first.tag_url, 'https://lia.test/fp/?t=REF0000001');
ok('and the new item is now the one on screen, resolved by its certificate code',
   await p.evaluate(() => _fpItem.serial_raw), 'H-2');
ok('the run counts the pass', await p.$eval('#fp-batch-count', e => e.textContent), '1 passed');
ok('and shows it', await p.$eval('#fp-batch-last', e => e.textContent.includes('H-1')), true);

// ── Undo last pass ──────────────────────────────────────────────────────────
ok('the queued upload holds the pass', await p.evaluate(() => LiaSync.queueLength()), 1);
await p.click('#fp-btn-batch-undo'); await p.waitForTimeout(200);
ok('undo takes the pass back out of the job', await p.evaluate(() => _job.items.length), 0);
ok('and out of the upload queue, so it cannot reach the server',
   await p.evaluate(() => LiaSync.queueLength()), 0);
ok('putting that item back on screen to fail or correct',
   await p.evaluate(() => _fpItem.serial_raw), 'H-1');
ok('the count follows', await p.$eval('#fp-batch-count', e => e.textContent), '0 passed');

// ── Fail ────────────────────────────────────────────────────────────────────
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(200);
ok('Fail stops the reader, so the next tap cannot pass it',
   await p.evaluate(() => window.__liveListeners()), 0);
ok('opens the checks', await p.$$eval('#fp-checks-list button', b => b.every(x => !x.disabled)), true);
ok('and will not save until a check is marked failed', await p.evaluate(() => ({
     shown: $('fp-save-panel').style.display !== 'none', disabled: $('fp-btn-save').disabled })),
   { shown:true, disabled:true });
ok('with a way back if he changed his mind',
   await p.evaluate(() => $('fp-btn-fail-cancel').style.display !== 'none'), true);

// Changed his mind: back to passing and listening.
await p.click('#fp-btn-fail-cancel'); await p.waitForTimeout(200);
ok('cancelling a fail puts the reader back on', await p.evaluate(() => ({
     live: window.__liveListeners(), locked: [...document.querySelectorAll('#fp-checks-list button')].every(x => x.disabled) })),
   { live:1, locked:true });

// Fail it for real: a check, then a photo.
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(200);
await p.evaluate(() => { const b = document.querySelectorAll('#fp-checks-list .fp-seg')[0].querySelectorAll('button');
  (_fpChecks[0].pass_answer ? b[1] : b[0]).click(); });
await p.waitForTimeout(150);
ok('marking a check turns the save into a removal', await p.$eval('#fp-btn-save', e => [e.textContent.trim(), e.disabled]),
   ['Add Photo & Remove →', false]);
await p.click('#fp-btn-save'); await p.waitForTimeout(200);
ok('which asks for a photo', await p.evaluate(() => !$('fp-condemn-sheet').classList.contains('hidden')), true);
ok('and will not confirm without one', await p.$eval('#fp-btn-confirm-condemn', e => e.disabled), true);
// A tap while the photo sheet is up is ignored — the reader is off.
await p.evaluate(() => window.__tap({ serial:'H-2' })); await p.waitForTimeout(250);
ok('no tap can land while an item is being failed', await p.evaluate(() => _job.items.length), 0);
await p.evaluate(() => { const blob = new Blob([new Uint8Array([0xff,0xd8,0xff,0xd9])], { type:'image/jpeg' });
  _fpPhoto = { blob, bytes:4, width:1, height:1, capturedAt:new Date().toISOString(), previewUrl:URL.createObjectURL(blob) }; fpRenderPhoto(); });
await p.click('#fp-btn-confirm-condemn'); await p.waitForTimeout(300);
const failed = await p.evaluate(() => _job.items[0]);
ok('the item is recorded as failed', [failed.serial_num, failed.overall_pass], ['H-1', false]);
ok('as answered on screen', failed.source, 'field');
ok('with its photo kept in the photo store, not in the job',
   [!!failed.photo.id, failed.photo.dataUrl, await p.evaluate(id => LiaPhotos.get(id).then(r => !!(r && r.blob)), failed.photo.id)],
   [true, undefined, true]);
ok('and queued for upload behind its inspection', await p.evaluate(id => {
     const q = JSON.parse(localStorage.getItem('lia-upload-queue'));
     const a = q.findIndex(e => e.clientId === id), b = q.findIndex(e => e.clientId === id + ':photo');
     return [a >= 0, b > a, q[b] && q[b].kind, q[b] && q[b].payload.captured_at === _job.items[0].capturedAt];
   }, failed.id), [true, true, 'fp_photo', true]);
ok('and the run is listening again with nothing on screen', await p.evaluate(() => ({
     live: window.__liveListeners(), item: !!_fpItem })), { live:1, item:false });
ok('counting it', await p.$eval('#fp-batch-count', e => e.textContent), '0 passed · 1 failed');

// ── Too little to pass: Add info, or it is skipped ──────────────────────────
await p.evaluate(() => { _fpBatch.lastAt = {}; window.__tap({ serial:'H-3' }); });   // on file, no type
await p.waitForTimeout(300);
ok('an item with no type stays on screen rather than stopping the run', await p.evaluate(() => ({
     serial: _fpItem.serial_raw, live: window.__liveListeners(), edit: $('fp-btn-batch-edit').textContent })),
   { serial:'H-3', live:1, edit:'Add info' });
const beforeSkip = await p.evaluate(() => _job.items.length);
await p.evaluate(() => window.__tap({ serial:'H-2' }));
await p.waitForTimeout(300);
ok('tapping on without adding it records nothing for it',
   await p.evaluate(() => _job.items.length), beforeSkip);
ok('and says so', await p.$eval('#fp-batch-last', e => /H-3[\s\S]*Not recorded — no equipment type/.test(e.textContent)), true);
ok('counting it as skipped', await p.$eval('#fp-batch-count', e => e.textContent), '0 passed · 1 failed · 1 skipped');

// Add info on Android: the reader keeps listening, and a tap takes what he typed.
await p.evaluate(() => { _fpBatch.lastAt = {}; window.__tap({ serial:'H-3' }); });   // H-2 passes
await p.waitForTimeout(300);
await p.click('#fp-btn-batch-edit'); await p.waitForTimeout(150);
ok('Add info opens the fields', await p.evaluate(() => $('fp-edit-form').style.display !== 'none'), true);
ok('without stopping the reader on Android', await p.evaluate(() => window.__liveListeners()), 1);
await p.selectOption('#fpf-equipment_type', await p.evaluate(() => LiaFpTypes.all()[0].slug));
await p.fill('#fpf-manufacturer', 'Guardian');
// An item already in the run is not "the next item" — it changes nothing.
await p.evaluate(() => window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' }));
await p.waitForTimeout(300);
ok('a tap on an item already in the run neither passes nor replaces the one on screen',
   await p.evaluate(() => [_fpItem && _fpItem.serial_raw, _job.items.some(i => i.serial_num === 'H-3')]), ['H-3', false]);
await p.evaluate(() => window.__tap({ url:'https://acme.example/tag/FP158354', uid:'AB:CD:EF:01' }));
await p.waitForTimeout(400);
const h3 = await p.evaluate(() => _job.items.find(i => i.serial_num === 'H-3'));
ok('a tap mid-edit passes the item with what was typed',
   h3 && [h3.overall_pass, h3.manufacturer, h3.source], [true, 'Guardian', 'field_batch']);

// ── An unknown tag: on screen, blank, with its link kept ─────────────────────
ok('a foreign tag does not stop the run or open the link sheet', await p.evaluate(() => ({
     sheet: !$('fp-link-sheet').classList.contains('hidden'), live: window.__liveListeners() })),
   { sheet:false, live:1 });
ok('it is on screen with the serial box EMPTY, never the hardware id',
   await p.evaluate(() => _fpItem.serial_raw), '');
ok('carrying the link and the tag id', await p.evaluate(() => [_fpItem.tag_url, _fpItem.nfc_tag_uid]),
   ['https://acme.example/tag/FP158354', 'ABCDEF01']);
ok('and offering Add info', await p.$eval('#fp-btn-batch-edit', e => e.textContent), 'Add info');
const beforeLink = await p.evaluate(() => ({ items:_job.items.length, queue:LiaSync.queueLength() }));
await p.click('#fp-btn-batch-stop'); await p.waitForTimeout(300);
ok('finishing on it records no inspection', await p.evaluate(() => _job.items.length), beforeLink.items);
ok('but keeps the link, so the next tap on it resolves',
   await p.evaluate(() => JSON.parse(localStorage.getItem('lia-upload-queue')).pop().kind), 'fp_tag_link');
ok('and the run is over', await p.evaluate(() => ({ batch: !!_fpBatch, live: window.__liveListeners() })),
   { batch:false, live:0 });

// ── Typed or scanned, the same as a tap ─────────────────────────────────────
await p.evaluate(() => { _job.items = []; fpRenderAll(); });
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
await p.click('#fp-btn-batch-type'); await p.waitForTimeout(100);
await p.fill('#fp-batch-serial', 'H-1'); await p.press('#fp-batch-serial', 'Enter');
await p.waitForTimeout(300);
ok('a typed serial puts the item on screen like a tap', await p.evaluate(() => _fpItem && _fpItem.serial_raw), 'H-1');
await p.evaluate(() => { window.startScan = () => {}; });
await p.click('#fp-btn-batch-scan'); await p.waitForTimeout(100);
await p.evaluate(() => _onScanSuccess('H-2')); await p.waitForTimeout(300);
ok('and a scanned one passes the item before it, like a tap',
   await p.evaluate(() => [_job.items.map(i => [i.serial_num, i.source]), _fpItem && _fpItem.serial_raw]),
   [[['H-1', 'field_batch']], 'H-2']);
ok('the reader is still listening after the scan', await p.evaluate(() => window.__liveListeners()), 1);
await p.evaluate(() => fpBatchStop());
await p.waitForTimeout(150);

// ── Finish passes the last item ─────────────────────────────────────────────
await p.evaluate(() => { _job.items = []; fpRenderAll(); });
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
await p.evaluate(() => window.__tap({ serial:'H-2' })); await p.waitForTimeout(300);
ok('Finish says it will pass what is on screen',
   await p.$eval('#fp-btn-batch-stop', e => e.textContent), 'Pass & finish');
await p.click('#fp-btn-batch-stop'); await p.waitForTimeout(300);
ok('and does — the last item has no next tap to pass it',
   await p.evaluate(() => _job.items.map(i => [i.serial_num, i.overall_pass])), [['H-2', true]]);

// ── Saved on every tap; the app dying loses nothing ────────────────────────
await p.evaluate(() => { _job.items = []; saveNow(); });
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
await p.evaluate(() => window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' })); await p.waitForTimeout(300);
const jobId = await p.evaluate(() => _job.id);
ok('the item tapped is saved into the job the moment it is tapped',
   await p.evaluate(id => (loadJobs()[id].fpInProgress || {}).item.serial_raw, jobId), 'H-1');
await p.reload(); await p.waitForTimeout(500);       // the app dies
await p.evaluate(id => openJob(id), jobId); await p.waitForTimeout(400);
ok('reopening the job records it as passed, as the next tap would have',
   await p.evaluate(() => _job.items.map(i => [i.serial_num, i.overall_pass, i.source])), [['H-1', true, 'field_batch']]);
ok('and it is no longer in hand', await p.evaluate(id => [!!_fpItem, !!loadJobs()[id].fpInProgress], jobId), [false, false]);

// ── Failed with no photo: the one alert ─────────────────────────────────────
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
await p.evaluate(() => window.__tap({ serial:'H-2' })); await p.waitForTimeout(300);
await p.click('#fp-btn-batch-fail'); await p.waitForTimeout(150);
await p.evaluate(() => { const b = document.querySelectorAll('#fp-checks-list .fp-seg')[0].querySelectorAll('button');
  (_fpChecks[0].pass_answer ? b[1] : b[0]).click(); });
await p.waitForTimeout(100);
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
ok('with the check he failed still failed',
   await p.evaluate(() => _fpChecks.some(c => c.answer !== c.pass_answer)), true);
ok('and only one way on from there: take the photo',
   await p.$eval('#fp-alert-leave', e => e.style.display), 'none');
await p.click('#fp-alert-go'); await p.waitForTimeout(150);
await p.click('#fp-btn-cancel-condemn'); await p.waitForTimeout(150);

// Leaving anyway is allowed, but only on purpose.
await p.evaluate(() => goScreen('jobs')); await p.waitForTimeout(150);
await p.click('#fp-alert-leave'); await p.waitForTimeout(200);
ok('"Leave — don\'t record it" leaves, recording nothing', await p.evaluate(id => ({
     jobs: $('screen-jobs').classList.contains('active'),
     recorded: loadJobs()[id].items.some(i => i.serial_num === 'H-2'),
     held: !!loadJobs()[id].fpInProgress }), jobId), { jobs:true, recorded:false, held:false });
await p.evaluate(id => openJob(id), jobId); await p.waitForTimeout(300);

// ── A run cannot outlive the screen it belongs to ───────────────────────────
// Left armed, the reader keeps firing into a job the tech has left — and on
// iOS leaves Apple's sheet up over whatever he moved to.
await p.click('#fp-btn-batch'); await p.waitForTimeout(200);
ok('a run is live before leaving', await p.evaluate(() => ({
     live: window.__liveListeners(), batch: !!_fpBatch })), { live:1, batch:true });
await p.evaluate(() => { _job.items = []; _fpBatch.lastAt = {}; window.__tap({ serial:'H-2' }); });
await p.waitForTimeout(300);
await p.evaluate(() => goScreen('jobs')); await p.waitForTimeout(200);
ok('leaving the screen records the item that was on it as passed, rather than losing it',
   await p.evaluate(() => loadJobs()[_job.id].items.map(i => [i.serial_num, i.overall_pass, i.source])),
   [['H-2', true, 'field_batch']]);
ok('ends the run and releases the reader',
   await p.evaluate(() => ({ live: window.__liveListeners(), batch: !!_fpBatch })),
   { live:0, batch:false });
ok('and puts the batch panel away',
   await p.evaluate(() => $('fp-batch-panel').style.display), 'none');

// ── iOS: same flow, but Apple's sheet sits over the app ─────────────────────
// The sheet would cover the form and the keyboard, so Add info stops the reader
// there, and finishing the form brings it back.
const q = await b.newPage();
q.on('pageerror', e => errs.push('ios: ' + e.message));
await q.addInitScript(nfcStub, 'ios');
await q.goto(BASE); await q.waitForTimeout(400);
await seed(q);
await q.click('#btn-new-job'); await q.waitForTimeout(150);
await q.click('.scope-opt[data-scope="fall_protection"]'); await q.waitForTimeout(300);
await q.click('#fp-btn-batch'); await q.waitForTimeout(200);
await q.evaluate(() => window.__tap({ serial:'H-1', uid:'04:A1:B2:C3' })); await q.waitForTimeout(300);
ok('iOS: a tap puts the item on screen the same way', await q.evaluate(() => _fpItem.serial_raw), 'H-1');
await q.evaluate(() => window.__tap({ serial:'H-2' })); await q.waitForTimeout(300);
ok('iOS: and the next tap passes it', await q.evaluate(() => _job.items.map(i => [i.serial_num, i.source])),
   [['H-1', 'field_batch']]);
await q.click('#fp-btn-batch-edit'); await q.waitForTimeout(150);
ok('iOS: Edit info stops the reader so its sheet does not cover the form',
   await q.evaluate(() => window.__liveListeners()), 0);
await q.click('#fp-btn-done-edit'); await q.waitForTimeout(200);
ok('iOS: and finishing the form brings the reader back',
   await q.evaluate(() => window.__liveListeners()), 1);
await q.close();

console.log('\npage errors:', errs.length ? errs : 'none');
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all passed');
await b.close(); server.close();
process.exit(fails || errs.length ? 1 : 0);
